FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget gnupg xvfb xauth tini fonts-liberation \
    && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google-chrome.gpg \
    && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY origin/package*.json ./origin/
RUN npm ci --prefix origin --omit=dev --ignore-scripts
COPY origin/*.mjs ./origin/
COPY src/echo.mjs src/live-protocol.mjs ./src/
RUN chown -R node:node /app
USER node
ENV PORT=9000 CHROME_NO_SANDBOX=1
EXPOSE 9000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["xvfb-run", "--auto-servernum", "node", "origin/server.mjs"]
