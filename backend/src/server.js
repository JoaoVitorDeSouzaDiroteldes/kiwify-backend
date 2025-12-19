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

// Caminho absoluto para downloads no Docker
const DOWNLOADS_DIR = '/app/downloads';

// Inicialização do SQLite
if (!fs.existsSync(DOWNLOADS_DIR)) {
    try {
        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    } catch (e) {
        console.error('Erro ao criar diretório downloads:', e);
    }
}
const dbPath = path.join(DOWNLOADS_DIR, 'bridge.db');
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

// Otimização Nginx: Node envia o header e o Nginx serve o arquivo diretamente (Performance V4)
app.use('/content', (req, res) => {
  // Traduz a URL pública para o caminho interno do Nginx (X-Accel-Redirect)
  res.setHeader('X-Accel-Redirect', `/internal_downloads${req.path}`);
  res.setHeader('Content-Type', 'application/octet-stream'); // Default, Nginx ajustará conforme extensão
  res.end();
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

// Helper para sanitizar nomes de arquivos (deve ser igual ao usado pelo downloader)
const sanitize = (s) => s ? s.replace(/[^a-zA-Z0-9]/g, '_') : '';

// Rota para listar a galeria de cursos baixados (Com injeção de URL de stream)
app.get('/gallery', (req, res) => {
  try {
    // Agora varremos também a pasta workspaces para encontrar cursos
    const workspacesDir = path.join(DOWNLOADS_DIR, 'workspaces');
    const courses = [];

    // Função auxiliar para processar um diretório de curso
    const processCourseDir = (dirPath, relativePathBase) => {
        const courseJsonPath = path.join(dirPath, 'course.json');
        if (fs.existsSync(courseJsonPath)) {
            try {
                const courseData = JSON.parse(fs.readFileSync(courseJsonPath, 'utf8'));
                const baseUrl = `https://${req.get('host')}/content/${relativePathBase}`;

                // Injeta a URL de stream em cada lição
                if (courseData.course && courseData.course.modules) {
                    courseData.course.modules.forEach(mod => {
                        if (mod.lessons) {
                            mod.lessons.forEach((lesson, lessonIndex) => {
                                if (lesson.video && lesson.video.name) {
                                    // Estrutura: /content/workspaceId/courseId/ModuleOrder_ModuleName/LessonOrder_LessonTitle/Video.mp4
                                    const moduleDir = `${mod.order}_${sanitize(mod.name)}`;
                                    const lessonDir = `${lessonIndex}_${sanitize(lesson.title)}`;
                                    lesson.video.streamUrl = `${baseUrl}/${moduleDir}/${lessonDir}/${lesson.video.name}`;
                                }
                            });
                        }
                    });
                }
                
                courses.push({
                    dirName: relativePathBase,
                    ...courseData
                });
            } catch (e) {
                console.error(`Erro ao processar curso em ${dirPath}`, e);
            }
        }
    };

    // 1. Processar cursos na raiz (legado)
    if (fs.existsSync(DOWNLOADS_DIR)) {
        const entries = fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== 'workspaces') {
                processCourseDir(path.join(DOWNLOADS_DIR, entry.name), entry.name);
            }
        }
    }

    // 2. Processar cursos dentro de workspaces
    if (fs.existsSync(workspacesDir)) {
        const workspaceEntries = fs.readdirSync(workspacesDir, { withFileTypes: true });
        for (const wsEntry of workspaceEntries) {
            if (wsEntry.isDirectory()) {
                const wsPath = path.join(workspacesDir, wsEntry.name);
                const courseEntries = fs.readdirSync(wsPath, { withFileTypes: true });
                for (const courseEntry of courseEntries) {
                    if (courseEntry.isDirectory()) {
                         // relativePathBase ex: workspaces/uuid/kiw_123
                         processCourseDir(path.join(wsPath, courseEntry.name), `workspaces/${wsEntry.name}/${courseEntry.name}`);
                    }
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
