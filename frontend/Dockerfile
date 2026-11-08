FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
RUN npm ci --workspace frontend
COPY frontend ./frontend
RUN npm run build:frontend
WORKDIR /app/frontend
EXPOSE 3000
CMD ["npm", "start"]
