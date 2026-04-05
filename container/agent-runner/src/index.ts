import fs from 'fs';
import path from 'path';
import { Codex, Thread } from '@openai/codex-sdk';
import type { ThreadOptions } from '@openai/codex-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  chatJid: string;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---CHESSCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CHESSCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function appendConversationArchive(prompt: string, response: string): void {
  try {
    const conversationsDir = '/workspace/assistant/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    const day = new Date().toISOString().split('T')[0];
    const filePath = path.join(conversationsDir, `${day}.md`);

    const now = new Date().toISOString();
    const safePrompt = prompt.length > 5000 ? `${prompt.slice(0, 5000)}...` : prompt;
    const safeResponse = response.length > 5000 ? `${response.slice(0, 5000)}...` : response;

    const block = [
      `## ${now}`,
      '',
      '**User**',
      '',
      '```text',
      safePrompt,
      '```',
      '',
      '**Assistant**',
      '',
      safeResponse,
      '',
      '---',
      '',
    ].join('\n');

    fs.appendFileSync(filePath, block);
  } catch (err) {
    log(`Failed to archive conversation turn: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      // ignore
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR).filter((f) => f.endsWith('.json')).sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
          type?: string;
          text?: string;
        };
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function buildInstructions(): string | undefined {
  const instructionPaths = [
    '/workspace/assistant/AGENTS.md',
  ];

  for (const instructionPath of instructionPaths) {
    if (fs.existsSync(instructionPath)) {
      return fs.readFileSync(instructionPath, 'utf-8');
    }
  }

  return undefined;
}

function buildThreadOptions(): ThreadOptions {
  return {
    workingDirectory: '/workspace/assistant',
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    networkAccessEnabled: false,
    webSearchEnabled: false,
  };
}

function createCodex(containerInput: ContainerInput, mcpServerPath: string): Codex {
  const instructions = buildInstructions();

  const config: any = {
    mcp_servers: {
      chessclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          CHESSCLAW_CHAT_JID: containerInput.chatJid,
        },
      },
    },
  };

  if (instructions) {
    config.instructions = instructions;
  }

  return new Codex({ config });
}

function createThread(
  codex: Codex,
  sessionId: string | undefined,
  threadOptions: ThreadOptions,
): Thread {
  return sessionId
    ? codex.resumeThread(sessionId, threadOptions)
    : codex.startThread(threadOptions);
}

async function runQuery(
  prompt: string,
  thread: Thread,
): Promise<{ newSessionId?: string; closedDuringQuery: boolean; bufferedMessages: string[] }> {
  let newSessionId = thread.id || undefined;
  let resultCount = 0;
  let closedDuringQuery = false;
  const bufferedMessages: string[] = [];

  const abortController = new AbortController();
  const pollTimer = setInterval(() => {
    if (shouldClose()) {
      closedDuringQuery = true;
      abortController.abort();
      return;
    }

    const pending = drainIpcInput();
    if (pending.length > 0) {
      bufferedMessages.push(...pending);
      log(`Buffered ${pending.length} IPC message(s) for next turn`);
    }
  }, IPC_POLL_MS);

  try {
    const { events } = await thread.runStreamed(prompt, {
      signal: abortController.signal,
    });

    for await (const event of events) {
      switch (event.type) {
        case 'thread.started':
          newSessionId = event.thread_id;
          log(`Thread initialized: ${newSessionId}`);
          break;
        case 'item.completed':
          if (event.item.type === 'agent_message') {
            resultCount++;
            const textResult = event.item.text?.trim() || '';
            log(`Result #${resultCount}: ${textResult.slice(0, 200)}`);
            appendConversationArchive(prompt, textResult);
            writeOutput({
              status: 'success',
              result: textResult || null,
              newSessionId,
            });
          }
          if (event.item.type === 'error') {
            throw new Error(event.item.message);
          }
          break;
        case 'turn.failed':
          throw new Error(event.error.message);
        case 'error':
          throw new Error(event.message);
        default:
          break;
      }
    }
  } catch (err) {
    if (!(closedDuringQuery && abortController.signal.aborted)) {
      throw err;
    }
    log('Turn aborted due to close sentinel');
  } finally {
    clearInterval(pollTimer);
  }

  log(`Query done. Results: ${resultCount}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, closedDuringQuery, bufferedMessages };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData) as ContainerInput;
    log(`Received input for chat: ${containerInput.chatJid}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  const threadOptions = buildThreadOptions();
  const codex = createCodex(containerInput, mcpServerPath);
  let thread = createThread(codex, sessionId, threadOptions);

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore
  }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user.]\n\n' + prompt;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      let queryResult: {
        newSessionId?: string;
        closedDuringQuery: boolean;
        bufferedMessages: string[];
      };

      try {
        queryResult = await runQuery(prompt, thread);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (sessionId) {
          log(`Resume failed for session ${sessionId}: ${errorMessage}`);
          log('Starting a fresh session and retrying this prompt');
          sessionId = undefined;
          thread = createThread(codex, undefined, threadOptions);
          queryResult = await runQuery(prompt, thread);
        } else {
          throw err;
        }
      }

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      if (containerInput.isScheduledTask) {
        log('Scheduled task turn completed, exiting');
        break;
      }

      if (queryResult.bufferedMessages.length > 0) {
        prompt = queryResult.bufferedMessages.join('\n');
        continue;
      }

      const immediate = drainIpcInput();
      if (immediate.length > 0) {
        prompt = immediate.join('\n');
        continue;
      }

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        break;
      }

      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
