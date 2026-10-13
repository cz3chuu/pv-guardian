FROM node:22-alpine AS base
WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN npm install

COPY . .
RUN npm run -w @pv-guardian/db generate
RUN npm run -w @pv-guardian/web build

EXPOSE 3000
CMD ["npm", "run", "-w", "@pv-guardian/web", "start"]
