# bs-front

Frontend для визуализации графа связей из ArangoDB коллекции friendships.

## Установка

```bash
npm install
```

## Настройка

Создайте файл `.env` на основе `.env.example`:

```bash
cp .env.example .env
```

Отредактируйте `.env` с вашими настройками ArangoDB:

```
ARANGO_URL=http://localhost:8529
ARANGO_DATABASE=big-sister-parser
ARANGO_USERNAME=root
ARANGO_PASSWORD=test
PORT=3001
```

## Запуск

```bash
npm start
```

Сервер запустится на порту 3001 (или указанном в `.env`).

Откройте в браузере: http://localhost:3001

## API

### GET /api/friendships

Возвращает данные для визуализации графа.

Параметры:
- `limit` (опционально) - максимальное количество связей (по умолчанию 1000)

Ответ:
```json
{
  "nodes": [
    {
      "id": "123",
      "name": "User Name",
      "_key": "123"
    }
  ],
  "links": [
    {
      "source": "123",
      "target": "456"
    }
  ]
}
```

## Особенности

- Подключение к ArangoDB только для чтения
- Визуализация графа с помощью d3.js
- Интерактивный граф с возможностью перетаскивания узлов
- Настройка лимита загружаемых данных
