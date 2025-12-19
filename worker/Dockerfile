# Usamos a imagem Debian para garantir compatibilidade com a imagem node:slim
FROM nimlang/nim:2.0.0 AS builder

WORKDIR /build

# Instala dependências de compilação
RUN apt-get update && apt-get install -y libssl-dev libpcre3-dev

# Copia o código fonte do downloader
COPY ./kiwifyDownload/ .

# Instala dependências do Nimble
RUN nimble install -y

# Compila o binário
RUN nim c -d:release -d:ssl --threads:on src/kiwifyDownload.nim

# --- Estágio Final ---
FROM node:20-slim

WORKDIR /app

# Instala dependências de runtime e compilação
RUN apt-get update && apt-get install -y ffmpeg wget python3 python3-pip make g++

# Copia o binário compilado
COPY --from=builder /build/src/kiwifyDownload /usr/local/bin/kiwifyDownload

# Configura o worker Node.js
COPY ./worker/package*.json ./
RUN npm install

COPY ./worker/src ./src

CMD ["npm", "start"]
