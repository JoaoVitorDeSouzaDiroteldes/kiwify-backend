FROM node:20-alpine

WORKDIR /app

# Instala dependências de compilação para better-sqlite3
RUN apk add --no-cache python3 make g++ 

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3001

CMD ["npm", "start"]
