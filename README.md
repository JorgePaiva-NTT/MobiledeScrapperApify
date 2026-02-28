# MobileDeScrapper

Initial Apify Actor template using **Apify + Crawlee + Cheerio**.

## Recommended workflow (Cursor / AI coding assistants)

1. Open this Actor directory in Cursor (or another AI coding assistant IDE).
2. Keep the initial Actor structure as-is.
3. Fill Actor metadata and schemas from `.actor/*`.
4. Implement scraping logic in `src/main.js`.

## Project structure

```text
.actor/
├── actor.json
├── input_schema.json
├── dataset_schema.json
└── output_schema.json
src/
└── main.js
Dockerfile
package.json
AGENTS.md
```

## Install dependencies

```bash
npm install
```

## Run locally

Use this exact command:

```bash
apify run
```

## Log in to Apify

Use this exact command:

```bash
apify login
```

## Push to Apify platform

Use this exact command:

```bash
apify push
```

## Notes

- Actor name: `MobileDeScrapper`
- Initial Actor version in `.actor/actor.json`: `0.0`
- `meta.generatedBy` in `.actor/actor.json` is set to `GPT-5.3-Codex`
- This is the fast Cheerio-based starter (no JavaScript rendering / anti-bot bypass like browser crawlers).
