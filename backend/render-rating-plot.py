#!/usr/bin/env python3

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
import argparse
import sqlite3
import sys

from PIL import Image, ImageDraw, ImageFont

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.paths import DATABASE_PATH


WIDTH = 1280
HEIGHT = 800
PADDING_LEFT = 96
PADDING_RIGHT = 56
PADDING_TOP = 90
PADDING_BOTTOM = 96
BACKGROUND = "#ffffff"
TEXT = "#10233a"
TEXT_MUTED = "#5d7390"
GRID = "#dbe8f5"
AXIS = "#89a6c7"
POINT_OUTLINE = "#ffffff"
PLATFORM_COLORS = {
    "Lichess": "#2ab8ff",
    "Chess.com": "#f3c56d",
    "Other": "#274b74",
}
PLATFORM_ALIASES = {
    "lichess": "Lichess",
    "chesscom": "Chess.com",
}


@dataclass(frozen=True)
class RatingPoint:
    timestamp: datetime
    rating: int


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render an Elo/rating evolution PNG from games stored in the database."
    )
    parser.add_argument("player_name", help="Player name to chart.")
    parser.add_argument(
        "--platform",
        choices=sorted(PLATFORM_ALIASES.keys()),
        required=True,
        help="Platform to chart: lichess or chesscom.",
    )
    parser.add_argument(
        "output_png",
        nargs="?",
        type=Path,
        help='Path to the generated PNG file. Defaults to "rating-evolution-{player}.png".',
    )
    parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="How many recent days to include. Default: 30.",
    )
    args = parser.parse_args()

    if args.days <= 0:
        print("Error: --days must be a positive integer.", file=sys.stderr)
        raise SystemExit(1)

    output_png = args.output_png or Path(
        f"rating-evolution-{_slugify(args.player_name)}.png"
    )

    if not DATABASE_PATH.exists():
        print(f"Error: database file not found: {DATABASE_PATH}.", file=sys.stderr)
        raise SystemExit(1)

    try:
        with sqlite3.connect(DATABASE_PATH) as connection:
            series = _load_rating_series(
                connection,
                args.player_name,
                args.days,
                PLATFORM_ALIASES[args.platform],
            )
    except sqlite3.Error as exc:
        print(f"Error: database failure: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    if not series:
        print(
            f'Error: no rating history found for "{args.player_name}" in the last {args.days} days.',
            file=sys.stderr,
        )
        raise SystemExit(1)

    image = _render_plot(
        series,
        player_name=args.player_name,
        days=args.days,
        platform_label=PLATFORM_ALIASES[args.platform],
    )
    output_png.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_png)


def _slugify(text: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in text).strip("-") or "player"


def _parse_game_timestamp(utc_date: str, utc_time: str) -> datetime | None:
    if not utc_date or "?" in utc_date:
        return None
    safe_time = utc_time if utc_time and "?" not in utc_time else "00:00:00"
    try:
        return datetime.strptime(
            f"{utc_date} {safe_time}", "%Y.%m.%d %H:%M:%S"
        ).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _normalize_platform(site: str) -> str:
    lowered = (site or "").lower()
    if "lichess" in lowered:
        return "Lichess"
    if "chess.com" in lowered:
        return "Chess.com"
    return "Other"


def _load_rating_series(
    connection: sqlite3.Connection,
    player_name: str,
    days: int,
    platform_label: str,
) -> dict[str, list[RatingPoint]]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = connection.execute(
        """
        SELECT
            site,
            white,
            black,
            white_elo,
            black_elo,
            utc_date,
            utc_time
        FROM games
        WHERE lower(white) = lower(?)
           OR lower(black) = lower(?)
        ORDER BY utc_date ASC, utc_time ASC, id ASC
        """,
        (player_name, player_name),
    ).fetchall()

    per_platform_per_day: dict[str, dict[str, RatingPoint]] = defaultdict(dict)
    for row in rows:
        site, white, black, white_elo, black_elo, utc_date, utc_time = row
        timestamp = _parse_game_timestamp(str(utc_date or ""), str(utc_time or ""))
        if timestamp is None or timestamp < cutoff:
            continue

        is_white = (white or "").casefold() == player_name.casefold()
        rating_text = str(white_elo if is_white else black_elo or "").strip()
        if not rating_text.isdigit():
            continue

        platform = _normalize_platform(str(site or ""))
        if platform != platform_label:
            continue

        day_key = timestamp.date().isoformat()
        per_platform_per_day[platform][day_key] = RatingPoint(
            timestamp=timestamp,
            rating=int(rating_text),
        )

    series: dict[str, list[RatingPoint]] = {}
    for platform, by_day in per_platform_per_day.items():
        points = [by_day[key] for key in sorted(by_day.keys())]
        if points:
            series[platform] = points
    return series


def _load_font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
        "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _render_plot(
    series: dict[str, list[RatingPoint]],
    *,
    player_name: str,
    days: int,
    platform_label: str,
) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)

    title_font = _load_font(38, bold=True)
    subtitle_font = _load_font(22)
    axis_font = _load_font(18)
    label_font = _load_font(20, bold=True)
    legend_font = _load_font(18)

    title = f"{player_name} rating evolution"
    subtitle = f"Last {days} days • {platform_label} • final rating per day"
    draw.text((PADDING_LEFT, 28), title, fill=TEXT, font=title_font)
    draw.text((PADDING_LEFT, 74), subtitle, fill=TEXT_MUTED, font=subtitle_font)

    plot_left = PADDING_LEFT
    plot_top = PADDING_TOP + 36
    plot_right = WIDTH - PADDING_RIGHT
    plot_bottom = HEIGHT - PADDING_BOTTOM

    all_points = [point for points in series.values() for point in points]
    min_time = min(point.timestamp for point in all_points)
    max_time = max(point.timestamp for point in all_points)
    if min_time == max_time:
        max_time = min_time + timedelta(days=1)

    min_rating = min(point.rating for point in all_points)
    max_rating = max(point.rating for point in all_points)
    if min_rating == max_rating:
        min_rating -= 20
        max_rating += 20
    else:
        padding = max(20, int((max_rating - min_rating) * 0.08))
        min_rating -= padding
        max_rating += padding

    for i in range(6):
        y = plot_top + ((plot_bottom - plot_top) * i / 5)
        rating_value = round(max_rating - ((max_rating - min_rating) * i / 5))
        draw.line((plot_left, y, plot_right, y), fill=GRID, width=1)
        label = str(rating_value)
        bbox = draw.textbbox((0, 0), label, font=axis_font)
        draw.text(
            (plot_left - (bbox[2] - bbox[0]) - 14, y - (bbox[3] - bbox[1]) / 2),
            label,
            fill=TEXT_MUTED,
            font=axis_font,
        )

    for i in range(5):
        x = plot_left + ((plot_right - plot_left) * i / 4)
        draw.line((x, plot_top, x, plot_bottom), fill=GRID, width=1)
        label_time = min_time + ((max_time - min_time) * i / 4)
        label = label_time.strftime("%b %d")
        bbox = draw.textbbox((0, 0), label, font=axis_font)
        draw.text(
            (x - (bbox[2] - bbox[0]) / 2, plot_bottom + 14),
            label,
            fill=TEXT_MUTED,
            font=axis_font,
        )

    draw.line((plot_left, plot_top, plot_left, plot_bottom), fill=AXIS, width=2)
    draw.line((plot_left, plot_bottom, plot_right, plot_bottom), fill=AXIS, width=2)

    draw.text((plot_left, plot_top - 28), "Rating", fill=TEXT, font=label_font)

    for platform in sorted(series.keys()):
        points = series[platform]
        color = PLATFORM_COLORS.get(platform, PLATFORM_COLORS["Other"])
        plot_points: list[tuple[float, float]] = []
        for point in points:
            x = plot_left + (
                (point.timestamp - min_time).total_seconds()
                / (max_time - min_time).total_seconds()
            ) * (plot_right - plot_left)
            y = plot_bottom - (
                (point.rating - min_rating) / (max_rating - min_rating)
            ) * (plot_bottom - plot_top)
            plot_points.append((x, y))

        if len(plot_points) >= 2:
            draw.line(plot_points, fill=color, width=4, joint="curve")
        for x, y in plot_points:
            draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=color, outline=POINT_OUTLINE, width=2)

    _draw_legend(draw, legend_font, series.keys())
    return image


def _draw_legend(
    draw: ImageDraw.ImageDraw,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    platforms: object,
) -> None:
    x = WIDTH - PADDING_RIGHT - 210
    y = 34
    for platform in sorted(platforms):
        color = PLATFORM_COLORS.get(platform, PLATFORM_COLORS["Other"])
        draw.rounded_rectangle((x, y + 5, x + 22, y + 19), radius=6, fill=color)
        draw.text((x + 32, y), str(platform), fill=TEXT, font=font)
        y += 30


if __name__ == "__main__":
    main()
