# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

FROM node:alpine

ADD package* ./
RUN npm install --production=false
ADD ./ ./
RUN npm run build

CMD ["node", "src/index.js"]
