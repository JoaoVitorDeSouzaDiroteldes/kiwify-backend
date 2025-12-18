const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Queue } = require('bullmq');
const { listCourses, getCourseSections } = require('./kiwifyClient');
const { transformKiwifyToDownloaderFormat } = require('./transformer');

const app = express();
const PORT = process.env.PORT || 3001;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const DOWNLOADS_DIR = path.join(__dirname, '../../downloads');

// Configuração da Fila de Download
const downloadQueue = new Queue('download-queue', {
  connection: {
    host: REDIS_HOST,
    port: REDIS_PORT
  }
});

// Configuração de CORS explícita
const corsOptions = {
  origin: '*', // Permite todas as origens. Para produção, restrinja a domínios específicos.
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  preflightContinue: false,
  optionsSuccessStatus: 204,
  allowedHeaders: 'Content-Type,Authorization,X-Workspace-Id'
};
app.use(cors(corsOptions));

app.use(express.json());

// Servir frontend estático
app.use(express.static(path.join(__dirname, '../public')));

// Servir arquivos estáticos da pasta downloads
app.use('/content', express.static(DOWNLOADS_DIR));

// Persistência simples de migrações
const MIGRATIONS_FILE = path.join(DOWNLOADS_DIR, 'migrations.json');

const getMigrations = () => {
  if (!fs.existsSync(MIGRATIONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(MIGRATIONS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
};

const saveMigrations = (migrations) => {
  if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.writeFileSync(MIGRATIONS_FILE, JSON.stringify(migrations, null, 2));
};

const updateMigrationStatus = (workspaceId, courseId, data) => {
  const migrations = getMigrations();
  const index = migrations.findIndex(m => m.workspaceId === workspaceId && m.courseId === courseId);
  if (index !== -1) {
    migrations[index] = { ...migrations[index], ...data, updatedAt: new Date().toISOString() };
  } else {
    migrations.push({ workspaceId, courseId, ...data, updatedAt: new Date().toISOString() });
  }
  saveMigrations(migrations);
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

// Nova Rota de Migração vinculada a Workspace
app.post('/courses/migrate', async (req, res) => {
  const token = getToken(req);
  const { courseId, workspaceId } = req.body;

  if (!token) return res.status(401).json({ error: 'Token não fornecido.' });
  if (!courseId || !workspaceId) return res.status(400).json({ error: 'courseId e workspaceId são obrigatórios.' });

  try {
    const kiwifyData = await getCourseSections(courseId, token);
    const courseName = kiwifyData.course ? kiwifyData.course.name : 'Unknown';

    // Registra início da migração
    updateMigrationStatus(workspaceId, courseId, {
      status: 'downloading',
      progress: 0,
      courseName,
      localPath: `/content/workspaces/${workspaceId}/${courseId}`
    });

    // Enfileira job com workspaceId
    await downloadQueue.add('download-course', { 
        ...kiwifyData, 
        workspaceId,
        courseId // Garante o ID para o worker atualizar o status
    });

    res.json({ 
        success: true, 
        message: 'Migração iniciada',
        workspaceId,
        courseId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Status das migrações do workspace
app.get('/workspaces/:workspaceId/status', (req, res) => {
  const { workspaceId } = req.params;
  const allMigrations = getMigrations();
  const workspaceMigrations = allMigrations.filter(m => m.workspaceId === workspaceId);

  res.json({
    workspaceId,
    migrations: workspaceMigrations
  });
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
