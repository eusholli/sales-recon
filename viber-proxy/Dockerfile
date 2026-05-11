FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY *.js ./
COPY scripts ./scripts

RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 8081

CMD ["node", "index.js"]
