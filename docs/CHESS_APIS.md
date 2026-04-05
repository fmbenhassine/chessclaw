# Chess APIs

Reference notes for the public chess APIs used by the host backend tooling.

## Chess.com Published Data API

Source:

- https://www.chess.com/news/view/published-data-api

Used by:

- [backend/download-games.py](/Users/mbh/projects/chessclaw/backend/download-games.py)

### List Monthly Archives

Description: array of monthly archives available for a player.

URL pattern:

- `https://api.chess.com/pub/player/{username}/games/archives`

Response shape:

```json
{
  "archives": [
    "https://api.chess.com/pub/player/erik/games/2009/10"
  ]
}
```

### Download Monthly PGN

Description: standard multi-game PGN for one month.

URL pattern:

- `https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}/pgn`

Notes:

- content type is PGN, not JSON
- init mode downloads one PGN per monthly archive
- sync mode downloads the latest relevant month and relies on ingest deduplication

## Lichess API

Source:

- https://lichess.org/api
- https://lichess.org/api#tag/games/operation/apiGamesUser

Used by:

- [backend/download-games.py](/Users/mbh/projects/chessclaw/backend/download-games.py)

### Export Games For A User

Description: download games of a user in PGN format.

URL pattern:

- `https://lichess.org/api/games/user/{username}`

Important query parameter:

- `since`: Unix epoch milliseconds used by sync mode

Notes:

- anonymous requests are rate limited
- if `LICHESS_API_KEY` is set, the backend script sends it as a bearer token
- init mode downloads the full export
- sync mode downloads games after the latest matching stored game
