# Используем официальный образ Node.js
FROM node:18-alpine

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --only=production

# Копируем остальные файлы приложения
COPY . .

# Переменные окружения для подключения к ArangoDB на хост-машине
# host.docker.internal резолвится в IP хоста из контейнера (Docker Desktop)
ENV ARANGO_URL=http://host.docker.internal:8529
ENV ARANGO_DATABASE=_system
ENV ARANGO_USERNAME=root
ENV ARANGO_PASSWORD=test
ENV PORT=3001

# Открываем порт
EXPOSE 3001

# Запускаем приложение
CMD ["node", "server.js"]
