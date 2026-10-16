FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY extension/package.json extension/package.json
RUN npm ci
COPY apps/web apps/web
ENV API_ORIGIN=http://api:8080
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @manyvo/web
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@manyvo/web"]
