FROM node:22-alpine AS builder


WORKDIR /app

RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY . .

RUN yarn prisma generate
RUN yarn build


FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./

RUN yarn workspaces focus --production


COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 5000

CMD [ "yarn", "start:prod:api" ]