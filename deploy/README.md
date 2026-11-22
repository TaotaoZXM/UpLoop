# Self-hosting outline

This public snapshot does not include historical production host, nginx, or cloud-server configuration.

To run the full app yourself:

1. Install Node.js 22 or newer and PostgreSQL.
2. Copy `deploy/.env.example` to `.env` in the project root.
3. Replace every placeholder. `DATABASE_URL` must be a local (or your own) PostgreSQL URL. `JWT_SECRET` and `DEVICE_TOKEN_SECRET` must be new random strings, not the example text.
4. Run `npm ci`, then `npm run migrate`, then `npm start`.
5. The server defaults to `127.0.0.1:3200`. If `BASE_PATH=/task`, open `http://127.0.0.1:3200/task/`.
6. Put your own reverse proxy in front if you need a public URL. Keep `BASE_PATH` consistent with the public path. The Node process should serve `web/` (`SERVE_STATIC=1`) so it can inject `<base href>`.

`npm run demo` does not use this file or PostgreSQL; see the root README.

GitHub Pages cannot host this application: the API, authentication, and database need a Node.js + PostgreSQL server.
