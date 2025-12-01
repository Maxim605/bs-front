const express = require('express');
const cors = require('cors');
const { Database, aql } = require('arangojs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Подключение к ArangoDB (только для чтения)
const db = new Database({
  url: process.env.ARANGO_URL || 'http://localhost:8529',
  databaseName: process.env.ARANGO_DATABASE || 'big-sister-parser',
  auth: {
    username: process.env.ARANGO_USERNAME || 'root',
    password: process.env.ARANGO_PASSWORD || 'test',
  },
});

// API endpoint для получения данных friendships
app.get('/api/friendships', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 1000;
    const startId = req.query.startId;
    const depth = parseInt(req.query.depth) || 2;
    
    let edges = [];
    
    if (startId) {
      // Построение графа с заданной глубиной начиная с startId
      // Используем GRAPH TRAVERSAL для получения всех связей до указанной глубины
      const graphName = 'friendships_graph'; // Имя графа в ArangoDB
      
      try {
        // Пытаемся использовать именованный граф
        // Получаем все пути от 1 до depth уровня
        const cursor = await db.query(aql`
          FOR v, e, p IN 1..${depth} OUTBOUND CONCAT('users/', ${startId}) 
          GRAPH ${graphName}
          OPTIONS { uniqueVertices: 'path', uniqueEdges: 'path' }
          LIMIT ${limit * 10}
          RETURN {
            edges: p.edges
          }
        `);
        
        const paths = await cursor.all();
        
        // Извлекаем все уникальные ребра из путей
        const edgeSet = new Set();
        const tempEdges = [];
        paths.forEach(path => {
          if (path.edges && Array.isArray(path.edges)) {
            path.edges.forEach(edge => {
              const from = edge._from ? edge._from.split('/')[1] : null;
              const to = edge._to ? edge._to.split('/')[1] : null;
              if (from && to) {
                // Сохраняем ребро в обоих направлениях для уникальности
                const edgeKey1 = `${from}-${to}`;
                const edgeKey2 = `${to}-${from}`;
                if (!edgeSet.has(edgeKey1) && !edgeSet.has(edgeKey2)) {
                  edgeSet.add(edgeKey1);
                  tempEdges.push({ from, to, _key: edge._key || `${from}-${to}` });
                }
              }
            });
          }
        });
        
        edges = tempEdges.slice(0, limit);
      } catch (graphError) {
        // Если именованный граф не существует, используем альтернативный подход
        console.log('Именованный граф не найден, используем альтернативный метод');
        
        // Рекурсивный поиск связей через коллекцию friendships с BFS
        const visitedNodes = new Set();
        const visitedEdges = new Set();
        const queue = [{ id: startId, level: 0 }];
        visitedNodes.add(startId);
        const allEdges = [];
        
        // Сначала добавляем начальный узел
        while (queue.length > 0 && allEdges.length < limit) {
          const current = queue.shift();
          
          if (current.level >= depth) continue;
          
          // Находим все связи текущего узла (исходящие и входящие)
          const connectionsCursor = await db.query(aql`
            FOR e IN friendships
              FILTER SPLIT(e._from, '/')[1] == ${current.id} || SPLIT(e._to, '/')[1] == ${current.id}
              RETURN {
                from: SPLIT(e._from, '/')[1],
                to: SPLIT(e._to, '/')[1],
                _key: e._key
              }
          `);
          
          const connections = await connectionsCursor.all();
          
          for (const edge of connections) {
            // Создаем уникальный ключ для ребра (независимо от направления)
            const edgeKey1 = `${edge.from}-${edge.to}`;
            const edgeKey2 = `${edge.to}-${edge.from}`;
            
            if (!visitedEdges.has(edgeKey1) && !visitedEdges.has(edgeKey2)) {
              visitedEdges.add(edgeKey1);
              allEdges.push(edge);
            }
            
            // Добавляем соседей в очередь для следующего уровня
            const neighborId = edge.from === current.id ? edge.to : edge.from;
            if (!visitedNodes.has(neighborId) && current.level < depth - 1) {
              visitedNodes.add(neighborId);
              queue.push({ id: neighborId, level: current.level + 1 });
            }
          }
        }
        
        edges = allEdges.slice(0, limit);
      }
    } else {
      // Получаем все связи из коллекции friendships (старое поведение)
      const cursor = await db.query(aql`
        FOR e IN friendships
          LIMIT ${limit}
          RETURN {
            from: SPLIT(e._from, '/')[1],
            to: SPLIT(e._to, '/')[1],
            _key: e._key
          }
      `);
      
      edges = await cursor.all();
    }
    
    // Получаем уникальные ID пользователей
    const userIds = new Set();
    edges.forEach(edge => {
      userIds.add(edge.from);
      userIds.add(edge.to);
    });
    
    // Получаем информацию о пользователях
    const users = [];
    for (const userId of userIds) {
      try {
        const userDoc = await db.collection('users').document(userId);
        users.push({
          id: userId,
          name: userDoc.name || userDoc.first_name || `User ${userId}`,
          _key: userDoc._key
        });
      } catch (e) {
        // Если пользователь не найден, добавляем с дефолтным именем
        users.push({
          id: userId,
          name: `User ${userId}`,
          _key: userId
        });
      }
    }
    
    res.json({
      nodes: users,
      links: edges.map(edge => ({
        source: edge.from,
        target: edge.to
      }))
    });
  } catch (error) {
    console.error('Ошибка при получении данных:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

