const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Servir arquivos estáticos do frontend e uploads
const publicDir = path.resolve(__dirname, '../public');
const uploadsDir = path.resolve(__dirname, '../uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadsDir));

// Configuração do Multer para armazenamento de arquivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Healthcheck
app.get('/api/status', (req, res) => {
  res.json({ status: 'online', database: 'SQLite', timestamp: new Date().toISOString() });
});

// Listar todos os pacientes
app.get('/api/pacientes', (req, res) => {
  try {
    const pacientes = db.prepare(`
      SELECT p.*, COUNT(a.id) as total_anexos
      FROM pacientes p
      LEFT JOIN anexos a ON p.id = a.paciente_id
      GROUP BY p.id
      ORDER BY p.id DESC
    `).all();
    res.json(pacientes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Buscar paciente por ID
app.get('/api/pacientes/:id', (req, res) => {
  try {
    const paciente = db.prepare('SELECT * FROM pacientes WHERE id = ?').get(req.params.id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente não encontrado' });
    }
    const anexos = db.prepare('SELECT * FROM anexos WHERE paciente_id = ?').all(req.params.id);
    res.json({ ...paciente, anexos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Criar novo paciente
app.post('/api/pacientes', (req, res) => {
  try {
    const { nome, cpf, contato, consultor, hospital, status, dataPrevista, prontuarios } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }

    const stmt = db.prepare(`
      INSERT INTO pacientes (nome, cpf, contato, consultor, hospital, status, dataPrevista, prontuarios)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      nome,
      cpf || '',
      contato || '',
      consultor || '',
      hospital || '',
      status || 'Em Análise',
      dataPrevista || '',
      prontuarios || ''
    );

    const novo = db.prepare('SELECT * FROM pacientes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(novo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Atualizar paciente
app.put('/api/pacientes/:id', (req, res) => {
  try {
    const { nome, cpf, contato, consultor, hospital, status, dataPrevista, prontuarios } = req.body;
    const { id } = req.params;

    const paciente = db.prepare('SELECT * FROM pacientes WHERE id = ?').get(id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente não encontrado' });
    }

    const stmt = db.prepare(`
      UPDATE pacientes SET
        nome = ?,
        cpf = ?,
        contato = ?,
        consultor = ?,
        hospital = ?,
        status = ?,
        dataPrevista = ?,
        prontuarios = ?
      WHERE id = ?
    `);

    stmt.run(
      nome !== undefined ? nome : paciente.nome,
      cpf !== undefined ? cpf : paciente.cpf,
      contato !== undefined ? contato : paciente.contato,
      consultor !== undefined ? consultor : paciente.consultor,
      hospital !== undefined ? hospital : paciente.hospital,
      status !== undefined ? status : paciente.status,
      dataPrevista !== undefined ? dataPrevista : paciente.dataPrevista,
      prontuarios !== undefined ? prontuarios : paciente.prontuarios,
      id
    );

    const atualizado = db.prepare('SELECT * FROM pacientes WHERE id = ?').get(id);
    res.json(atualizado);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Excluir paciente
app.delete('/api/pacientes/:id', (req, res) => {
  try {
    const { id } = req.params;
    // Remove arquivos de anexo associados do disco
    const anexos = db.prepare('SELECT * FROM anexos WHERE paciente_id = ?').all(id);
    for (const anexo of anexos) {
      if (fs.existsSync(anexo.caminho_arquivo)) {
        try { fs.unlinkSync(anexo.caminho_arquivo); } catch (_) {}
      }
    }

    const stmt = db.prepare('DELETE FROM pacientes WHERE id = ?');
    const result = stmt.run(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Paciente não encontrado' });
    }

    res.json({ message: 'Paciente excluído com sucesso' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload de arquivo para prontuário de paciente
app.post('/api/pacientes/:id/anexos', upload.single('arquivo'), (req, res) => {
  try {
    const { id } = req.params;
    const paciente = db.prepare('SELECT * FROM pacientes WHERE id = ?').get(id);
    if (!paciente) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Paciente não encontrado' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const stmt = db.prepare(`
      INSERT INTO anexos (paciente_id, nome_original, caminho_arquivo, tamanho_bytes, mime_type)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      id,
      req.file.originalname,
      req.file.path,
      req.file.size,
      req.file.mimetype
    );

    const anexo = db.prepare('SELECT * FROM anexos WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(anexo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Excluir anexo
app.delete('/api/anexos/:id', (req, res) => {
  try {
    const { id } = req.params;
    const anexo = db.prepare('SELECT * FROM anexos WHERE id = ?').get(id);
    if (!anexo) {
      return res.status(404).json({ error: 'Anexo não encontrado' });
    }

    if (fs.existsSync(anexo.caminho_arquivo)) {
      try { fs.unlinkSync(anexo.caminho_arquivo); } catch (_) {}
    }

    db.prepare('DELETE FROM anexos WHERE id = ?').run(id);
    res.json({ message: 'Anexo excluído com sucesso' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Inicia servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
