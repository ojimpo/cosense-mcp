FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --ignore-scripts
COPY --from=builder /app/build/ build/

ENV TRANSPORT=http
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000
CMD ["node", "build/index.js"]
