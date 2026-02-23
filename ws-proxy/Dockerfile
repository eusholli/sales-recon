FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY *.js ./

RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 8080

CMD ["node", "index.js"]
