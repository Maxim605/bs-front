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
    const onlyWithFriends = req.query.onlyWithFriends === 'true';
    const minConnections = parseInt(req.query.minConnections) || 2;
    
    let edges = [];
    
    if (startId) {
      // Построение графа с заданной глубиной начиная с startId
      const graphName = 'friendships_graph';
      
      try {
        // Пытаемся использовать именованный граф с оптимизированным запросом
        // Дедупликация и нормализация ребер выполняется в AQL
        // Валидация startId: только безопасные символы для предотвращения инъекций
        const sanitizedStartId = String(startId).replace(/[^0-9a-zA-Z_-]/g, '');
        const startDoc = `users/${sanitizedStartId}`;
        
        const cursor = await db.query(aql`
          FOR v, e, p IN 1..${depth} OUTBOUND ${startDoc}
            GRAPH ${graphName}
            OPTIONS { uniqueVertices: 'global', uniqueEdges: 'global' }
            LET from = SPLIT(e._from, '/')[1]
            LET to = SPLIT(e._to, '/')[1]
            LET fromNum = TO_NUMBER(from)
            LET toNum = TO_NUMBER(to)
            LET a = (fromNum <= toNum ? from : to)
            LET b = (fromNum <= toNum ? to : from)
            COLLECT pair = { a, b }
            LIMIT ${limit}
            RETURN { from: pair.a, to: pair.b, _key: CONCAT(pair.a, '-', pair.b) }
        `);
        
        edges = await cursor.all();
      } catch (graphError) {
        // Если именованный граф не существует, используем BFS по уровням батчами
        console.log('Именованный граф не найден, используем BFS по уровням');
        
        // Валидация startId для BFS тоже
        const sanitizedStartId = String(startId).replace(/[^0-9a-zA-Z_-]/g, '');
        let frontier = new Set([sanitizedStartId]);
        const visitedNodes = new Set([sanitizedStartId]);
        const visitedEdges = new Set();
        const allEdges = [];
        
        // BFS по уровням - один запрос на уровень вместо N запросов
        for (let level = 0; level < depth && allEdges.length < limit; level++) {
          const frontierArr = Array.from(frontier);
          if (frontierArr.length === 0) break;
          
          // Используем Set для O(1) проверки принадлежности вместо O(N) includes
          const frontierSet = new Set(frontierArr);
          frontier = new Set();
          
          // Один запрос для всех узлов текущего фронтира
          // Примечание: LIMIT применяется после сбора всех уникальных ребер уровня
          // для обеспечения полного покрытия уровня перед переходом к следующему
          const cursor = await db.query(aql`
            FOR e IN friendships
              LET f = SPLIT(e._from, '/')[1]
              LET t = SPLIT(e._to, '/')[1]
              FILTER f IN ${frontierArr} OR t IN ${frontierArr}
              LET fromNum = TO_NUMBER(f)
              LET toNum = TO_NUMBER(t)
              LET a = (fromNum <= toNum ? f : t)
              LET b = (fromNum <= toNum ? t : f)
              COLLECT pair = { a, b }
              RETURN { 
                from: pair.a, 
                to: pair.b, 
                _key: CONCAT(pair.a, '-', pair.b)
              }
          `);
          
          const connections = await cursor.all();
          
          // Применяем лимит после обработки уровня для обеспечения полного покрытия
          const remainingLimit = limit - allEdges.length;
          
          for (const edge of connections) {
            if (allEdges.length >= limit) break;
            
            const key = `${edge.from}-${edge.to}`;
            
            if (!visitedEdges.has(key)) {
              visitedEdges.add(key);
              allEdges.push({ from: edge.from, to: edge.to, _key: edge._key });
            }
            
            // Добавляем соседей в следующий фронтир
            // Используем Set.has для O(1) проверки вместо O(N) includes
            const fromInFrontier = frontierSet.has(edge.from);
            const toInFrontier = frontierSet.has(edge.to);
            
            if (fromInFrontier && !visitedNodes.has(edge.to) && level < depth - 1) {
              visitedNodes.add(edge.to);
              frontier.add(edge.to);
            }
            if (toInFrontier && !visitedNodes.has(edge.from) && level < depth - 1) {
              visitedNodes.add(edge.from);
              frontier.add(edge.from);
            }
          }
          
          if (allEdges.length >= limit) break;
        }
        
        edges = allEdges;
      }
    } else {
      // Получаем все связи из коллекции friendships (старое поведение)
      // Нормализуем ребра для консистентности
      const cursor = await db.query(aql`
        FOR e IN friendships
          LIMIT ${limit}
          LET from = SPLIT(e._from, '/')[1]
          LET to = SPLIT(e._to, '/')[1]
          LET fromNum = TO_NUMBER(from)
          LET toNum = TO_NUMBER(to)
          LET a = (fromNum <= toNum ? from : to)
          LET b = (fromNum <= toNum ? to : from)
          COLLECT pair = { a, b }
          RETURN {
            from: pair.a,
            to: pair.b,
            _key: CONCAT(pair.a, '-', pair.b)
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
    
    // Если включен фильтр "только люди с друзьями", итеративно удаляем узлы с недостаточным количеством связей
    if (onlyWithFriends && edges.length > 0) {
      let changed = true;
      let iteration = 0;
      const maxIterations = 100;
      
      while (changed && iteration < maxIterations) {
        changed = false;
        iteration++;
        
        // Подсчитываем степени узлов в JS (быстрее для уже загруженных данных)
        // Можно было бы в БД, но для итеративного процесса проще в памяти
        const nodeConnections = new Map();
        edges.forEach(edge => {
          nodeConnections.set(edge.from, (nodeConnections.get(edge.from) || 0) + 1);
          nodeConnections.set(edge.to, (nodeConnections.get(edge.to) || 0) + 1);
        });
        
        // Находим узлы, которые нужно удалить
        const nodesToRemove = new Set();
        nodeConnections.forEach((count, userId) => {
          if (count < minConnections) {
            nodesToRemove.add(userId);
            changed = true;
          }
        });
        
        // Удаляем узлы и связанные ребра
        if (nodesToRemove.size > 0) {
          edges = edges.filter(edge => 
            !nodesToRemove.has(edge.from) && !nodesToRemove.has(edge.to)
          );
          
          userIds.clear();
          edges.forEach(edge => {
            userIds.add(edge.from);
            userIds.add(edge.to);
          });
        }
      }
      
      console.log(`Фильтрация завершена за ${iteration} итераций. Осталось узлов: ${userIds.size}, связей: ${edges.length}`);
    }
    
    // Батчевое получение информации о пользователях (один запрос вместо N)
    const userKeys = Array.from(userIds);
    const users = [];
    
    if (userKeys.length > 0) {
      // Разбиваем на батчи по 1000 для избежания слишком больших запросов
      const batchSize = 1000;
      const userMap = new Map();
      
      for (let i = 0; i < userKeys.length; i += batchSize) {
        const batch = userKeys.slice(i, i + batchSize);
        
        const usersCursor = await db.query(aql`
          FOR u IN users
            FILTER u._key IN ${batch}
            RETURN { 
              id: u._key, 
              name: (u.name != null ? u.name : (u.first_name != null ? u.first_name : CONCAT('User ', u._key))), 
              _key: u._key,
              cluster: u.cluster
            }
        `);
        
        const usersBatch = await usersCursor.all();
        usersBatch.forEach(u => userMap.set(u.id, u));
      }
      
      // Создаем массив пользователей, добавляя дефолтные значения для отсутствующих
      userKeys.forEach(k => {
        const user = userMap.get(k);
        users.push(user || {
          id: k,
          name: `User ${k}`,
          _key: k,
          cluster: undefined
        });
      });
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

// API endpoint для получения данных конкретного пользователя
app.get('/api/user/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Валидация userId
    const sanitizedUserId = String(userId).replace(/[^0-9a-zA-Z_-]/g, '');
    
    const cursor = await db.query(aql`
      FOR u IN users
        FILTER u._key == ${sanitizedUserId}
        LIMIT 1
        RETURN u
    `);
    
    const users = await cursor.all();
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    res.json(users[0]);
  } catch (error) {
    console.error('Ошибка при получении данных пользователя:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

