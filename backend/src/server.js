const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Queue } = require('bullmq');
const { listCourses, getCourseSections } = require('./kiwifyClient');

const app = express();
const PORT = process.env.PORT || 3001;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const DOWNLOADS_DIR = path.join(__dirname, '../../downloads');

// Inicialização do SQLite
const dbPath = path.join(DOWNLOADS_DIR, 'bridge.db');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
const db = new Database(dbPath);

// Criar tabelas se não existirem
db.exec(`
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspaceId TEXT,
    courseId TEXT,
    courseName TEXT,
    status TEXT,
    progress INTEGER DEFAULT 0,
    localPath TEXT,
    error TEXT,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(workspaceId, courseId)
  )
`);

// Configuração da Fila de Download
const downloadQueue = new Queue('download-queue', {
  connection: { host: REDIS_HOST, port: REDIS_PORT }
});

// Configuração de CORS
app.use(cors({
  origin: '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  allowedHeaders: 'Content-Type,Authorization,X-Workspace-Id'
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Otimização Nginx: Node envia o header e o Nginx serve o arquivo
app.use('/content', (req, res) => {
  const filePath = path.join(DOWNLOADS_DIR, req.path);
  // Se estiver atrás do Nginx configurado com X-Accel, use:
  // res.setHeader('X-Accel-Redirect', `/internal_downloads${req.path}`);
  // res.end();
  // Por enquanto, mantemos o static do Express para compatibilidade direta:
  express.static(DOWNLOADS_DIR)(req, res);
});

const updateMigrationStatus = (workspaceId, courseId, data) => {
  const stmt = db.prepare(`
    INSERT INTO migrations (workspaceId, courseId, courseName, status, progress, localPath, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(workspaceId, courseId) DO UPDATE SET
      status = excluded.status,
      progress = excluded.progress,
      updatedAt = CURRENT_TIMESTAMP
  `);
  stmt.run(workspaceId, courseId, data.courseName || '', data.status, data.progress || 0, data.localPath || '');
};

// Middleware para extrair o token
const getToken = (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.split(' ')[1];
};

// Rota para testar se o servidor está no ar
app.get('/', (req, res) => {
  res.send('Servidor da Kiwify Platform está rodando!');
});

// Rota unificada para suportar ambos os formatos de chamada do frontend
app.post(['/courses/migrate', '/courses/:id/prepare-download'], async (req, res) => {
  const token = getToken(req);
  const courseId = req.params.id || req.body.courseId;
  const { workspaceId } = req.body;

  if (!token) return res.status(401).json({ error: 'Token não fornecido.' });
  if (!courseId || !workspaceId) return res.status(400).json({ error: 'courseId e workspaceId são obrigatórios.' });

  try {
    const kiwifyData = await getCourseSections(courseId, token);
    const courseName = kiwifyData.course ? kiwifyData.course.name : 'Unknown';

    updateMigrationStatus(workspaceId, courseId, {
      status: 'downloading',
      progress: 0,
      courseName,
      localPath: `/content/workspaces/${workspaceId}/${courseId}`
    });

    await downloadQueue.add('download-course', { 
        ...kiwifyData, 
        workspaceId,
        courseId
    });

    res.json({ success: true, workspaceId, courseId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/workspaces/:workspaceId/status', (req, res) => {
  const { workspaceId } = req.params;
  const migrations = db.prepare('SELECT * FROM migrations WHERE workspaceId = ?').all(workspaceId);
  res.json({ workspaceId, migrations });
});

// Rota para listar os cursos
app.get('/courses', async (req, res) => {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Token de autorização não fornecido.' });
  }

  try {
    const courses = await listCourses(token);
    res.json(courses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rota para obter o JSON transformado pronto para o downloader
app.get('/courses/:id/prepare-download', async (req, res) => {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Token de autorização não fornecido.' });
  }

  const { id } = req.params;

  try {
    const kiwifyData = await getCourseSections(id, token);
    // const downloaderJson = transformKiwifyToDownloaderFormat(kiwifyData);
    // O script de migração espera o JSON completo da Kiwify, sem transformação.
    
    // Adiciona o job na fila para o Worker processar
    await downloadQueue.add('download-course', kiwifyData);
    const courseName = kiwifyData.course ? kiwifyData.course.name : 'Unknown Course';
    console.log(`Job de download enfileirado para o curso: ${courseName}`);

    res.json({ 
        success: true, 
        message: 'Download iniciado em background',
        config: kiwifyData // Retorna config para debug no frontend se quiser
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rota para listar a galeria de cursos baixados
app.get('/gallery', (req, res) => {
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      return res.json([]);
    }

    const entries = fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true });
    const courses = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const courseJsonPath = path.join(DOWNLOADS_DIR, entry.name, 'course.json');
        if (fs.existsSync(courseJsonPath)) {
          try {
            const courseData = JSON.parse(fs.readFileSync(courseJsonPath, 'utf8'));
            // Adiciona o caminho relativo para a capa e metadados
            // Assumindo que a capa original é uma URL, mantemos. 
            // O front pode decidir se usa a URL remota ou se implementamos download de capa depois.
            // Para simplificar, retornamos a estrutura completa.
            courses.push({
              dirName: entry.name,
              ...courseData
            });
          } catch (e) {
            console.error(`Erro ao ler course.json de ${entry.name}`, e);
          }
        }
      }
    }

    res.json(courses);
  } catch (error) {
    console.error('Erro na galeria:', error);
    res.status(500).json({ error: 'Erro ao listar galeria' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
