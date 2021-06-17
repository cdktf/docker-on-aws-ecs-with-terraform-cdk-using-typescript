FROM node:alpine

ADD package* ./
RUN npm install --production=false
ADD ./ ./
RUN npm run build

CMD ["node", "src/index.js"]
