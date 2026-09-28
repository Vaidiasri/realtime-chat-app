FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Copy all of /app in one step: npm workspaces link @chat/shared with a symlink,
# and copying packages one by one would leave that link dangling.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
