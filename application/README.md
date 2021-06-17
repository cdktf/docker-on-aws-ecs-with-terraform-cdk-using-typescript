# Local Development

- `cp .env.sample .env`
- `vim .env`
- `npm install -g dotenv-cli`
- `cd application/frontend && dotenv -e ../../.env -- npm start`
- `cd application/backend && dotenv -e ../../.env -- npm start`
- `dotenv -- docker run --name postgres --rm -e POSTGRES_PASSWORD -e POSTGRES_USER -e POSTGRES_DB -p "$POSTGRES_HOST:$POSTGRES_PORT":0.0.0.0/5432 postgres`
