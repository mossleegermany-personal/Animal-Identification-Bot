# Animal Identification Bot 🦁🐦🦋

A Telegram bot that identifies animals and wildlife from photos using AI.

## Features

- **Photo Identification** - Send a photo and the bot asks if you want to identify the animal
- **Multiple Photos** - Send several photos at once, each gets identified separately
- **Target Selection** - Specify what to identify (e.g., "the bird on the left") or use `/auto` for all animals
- **Location-Aware** - Provide location for more accurate species identification
- **EXIF Support** - Automatically extracts GPS coordinates from photo metadata
- **Quality Detection** - Detects low resolution, obstructed, or distant subjects
- **Reply to Identify** - Reply to any photo with `/identify` to start identification

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and instructions |
| `/help` | Show help and usage guide |
| `/identify` | Reply to a photo to identify it |
| `/auto` | Auto-identify all animals in the photo |
| `/skip` | Skip location input |
| `/status` | Check your weekly usage |
| `/cancel` | Cancel current identification |

## How It Works

1. Send a photo to the bot
2. Bot asks "Would you like me to identify?" with Yes/No buttons
3. If Yes, specify what to identify or use `/auto`
4. Optionally provide location for better accuracy
5. Receive detailed identification with species info

## Rate Limits

- 50 identifications per group per week
- Resets every Monday at 00:00 SGT

## Tech Stack

- **grammy** - Telegram Bot Framework
- **Google Gemini 2.5 Pro** - AI Vision Model
- **sharp** - Image Processing
- **Express** - Webhook Server

## Data Sources

- eBird
- GBIF
- iNaturalist
