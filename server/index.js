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

// Helper: Normalização das 3 Zonas Fixas: Fortaleza, Metrópole (Metropolis), Interior
function normalizarZona(zona) {
  if (!zona) return 'Fortaleza';
  const z = String(zona).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (z.includes('metro')) return 'Metrópole (Metropolis)';
  if (z.includes('fortal')) return 'Fortaleza';
  if (z.includes('interior')) return 'Interior';
  return 'Fortaleza';
}

// Helper: Resolução de Hospital, Zona e Rota para Paciente
function resolverDadosHospital(hospital_id, hospitalNome, zonaInput, rotaInput) {
  let resolvedHospitalId = hospital_id ? Number(hospital_id) : null;
  let resolvedHospital = hospitalNome ? String(hospitalNome).trim() : '';
  let resolvedZona = zonaInput ? normalizarZona(zonaInput) : 'Fortaleza';
  let resolvedRota = rotaInput ? String(rotaInput).trim() : '';

  if (resolvedHospitalId) {
    const h = db.prepare(`
      SELECT h.*, r.nome as rota_nome
      FROM hospitais h
      LEFT JOIN rotas r ON h.rota_id = r.id
      WHERE h.id = ?
    `).get(resolvedHospitalId);
    if (h) {
      resolvedHospital = h.nome;
      resolvedZona = h.zona;
      resolvedRota = h.rota_nome || '';
    }
  } else if (resolvedHospital) {
    const h = db.prepare(`
      SELECT h.*, r.nome as rota_nome
      FROM hospitais h
      LEFT JOIN rotas r ON h.rota_id = r.id
      WHERE LOWER(h.nome) = LOWER(?)
    `).get(resolvedHospital);
    if (h) {
      resolvedHospitalId = h.id;
      resolvedHospital = h.nome;
      resolvedZona = h.zona;
      resolvedRota = h.rota_nome || '';
    }
  }

  return {
    hospital_id: resolvedHospitalId,
    hospital: resolvedHospital,
    zona: resolvedZona,
    rota: resolvedRota
  };
}

// Healthcheck
app.get('/api/status', (req, res) => {
  res.json({ status: 'online', database: 'SQLite', timestamp: new Date().toISOString() });
});

// ==========================================
// ROTAS (Gestão Dinâmica de Rotas)
// ==========================================

// Listar todas as rotas com contagem de hospitais associados
app.get('/api/rotas', (req, res) => {
  try {
    const rotas = db.prepare(`
      SELECT r.*, COUNT(h.id) as total_hospitais
      FROM rotas r
      LEFT JOIN hospitais h ON h.rota_id = r.id
      GROUP BY r.id
      ORDER BY r.nome ASC
    `).all();
    res.json(rotas);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Criar nova rota
app.post('/api/rotas', (req, res) => {
  try {
    const { nome, descricao } = req.body;
    if (!nome || !nome.trim()) {
      return res.status(400).json({ error: 'O nome da rota é obrigatório' });
    }
    const existente = db.prepare('SELECT id FROM rotas WHERE LOWER(nome) = LOWER(?)').get(nome.trim());
    if (existente) {
      return res.status(400).json({ error: 'Já existe uma rota cadastrada com este nome' });
    }
    const stmt = db.prepare('INSERT INTO rotas (nome, descricao) VALUES (?, ?)');
    const result = stmt.run(nome.trim(), (descricao || '').trim());
    const nova = db.prepare('SELECT *, 0 as total_hospitais FROM rotas WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(nova);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Atualizar rota
app.put('/api/rotas/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { nome, descricao } = req.body;
    if (!nome || !nome.trim()) {
      return res.status(400).json({ error: 'O nome da rota é obrigatório' });
    }
    const rota = db.prepare('SELECT * FROM rotas WHERE id = ?').get(id);
    if (!rota) {
      return res.status(404).json({ error: 'Rota não encontrada' });
    }
    const duplicada = db.prepare('SELECT id FROM rotas WHERE LOWER(nome) = LOWER(?) AND id != ?').get(nome.trim(), id);
    if (duplicada) {
      return res.status(400).json({ error: 'Já existe outra rota com este nome' });
    }

    db.prepare('UPDATE rotas SET nome = ?, descricao = ? WHERE id = ?').run(
      nome.trim(),
      descricao !== undefined ? (descricao || '').trim() : rota.descricao,
      id
    );

    // Atualiza nome da rota em pacientes
    db.prepare('UPDATE pacientes SET rota = ? WHERE rota = ?').run(nome.trim(), rota.nome);

    const atualizada = db.prepare(`
      SELECT r.*, COUNT(h.id) as total_hospitais
      FROM rotas r
      LEFT JOIN hospitais h ON h.rota_id = r.id
      WHERE r.id = ?
      GROUP BY r.id
    `).get(id);
    res.json(atualizada);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Excluir rota
app.delete('/api/rotas/:id', (req, res) => {
  try {
    const { id } = req.params;
    const rota = db.prepare('SELECT * FROM rotas WHERE id = ?').get(id);
    if (!rota) {
      return res.status(404).json({ error: 'Rota não encontrada' });
    }
    // Desvincula hospitais e pacientes
    db.prepare('UPDATE hospitais SET rota_id = NULL WHERE rota_id = ?').run(id);
    db.prepare('UPDATE pacientes SET rota = NULL WHERE rota = ?').run(rota.nome);
    db.prepare('DELETE FROM rotas WHERE id = ?').run(id);
    res.json({ message: 'Rota excluída com sucesso' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// HOSPITAIS (Gestão de Hospitais por Rota e Zona)
// ==========================================

// Listar hospitais com rota e contagem de pacientes
app.get('/api/hospitais', (req, res) => {
  try {
    const hospitais = db.prepare(`
      SELECT h.*, r.nome as rota_nome,
             (SELECT COUNT(*) FROM pacientes p WHERE p.hospital_id = h.id OR (p.hospital_id IS NULL AND LOWER(p.hospital) = LOWER(h.nome))) as total_pacientes
      FROM hospitais h
      LEFT JOIN rotas r ON h.rota_id = r.id
      ORDER BY h.nome ASC
    `).all();
    res.json(hospitais);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Criar hospital
app.post('/api/hospitais', (req, res) => {
  try {
    const { nome, zona, rota_id, endereco, telefone } = req.body;
    if (!nome || !nome.trim()) {
      return res.status(400).json({ error: 'Nome do hospital é obrigatório' });
    }
    const zonaNormalizada = normalizarZona(zona);
    const rotaValidaId = rota_id ? Number(rota_id) : null;

    const stmt = db.prepare(`
      INSERT INTO hospitais (nome, zona, rota_id, endereco, telefone)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      nome.trim(),
      zonaNormalizada,
      rotaValidaId,
      (endereco || '').trim(),
      (telefone || '').trim()
    );

    const novo = db.prepare(`
      SELECT h.*, r.nome as rota_nome, 0 as total_pacientes
      FROM hospitais h
      LEFT JOIN rotas r ON h.rota_id = r.id
      WHERE h.id = ?
    `).get(result.lastInsertRowid);

    // Opcionalmente vincula pacientes existentes que tenham o mesmo nome
    let rotaNome = novo.rota_nome || '';
    db.prepare(`
      UPDATE pacientes SET hospital_id = ?, zona = ?, rota = ?
      WHERE hospital_id IS NULL AND LOWER(hospital) = LOWER(?)
    `).run(novo.id, zonaNormalizada, rotaNome, novo.nome);

    res.status(201).json(novo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Atualizar hospital
app.put('/api/hospitais/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { nome, zona, rota_id, endereco, telefone } = req.body;
    const hospitalAtual = db.prepare('SELECT * FROM hospitais WHERE id = ?').get(id);
    if (!hospitalAtual) {
      return res.status(404).json({ error: 'Hospital não encontrado' });
    }

    const novoNome = nome !== undefined ? nome.trim() : hospitalAtual.nome;
    const novaZona = zona !== undefined ? normalizarZona(zona) : hospitalAtual.zona;
    const novaRotaId = rota_id !== undefined ? (rota_id ? Number(rota_id) : null) : hospitalAtual.rota_id;
    const novoEndereco = endereco !== undefined ? (endereco || '').trim() : hospitalAtual.endereco;
    const novoTelefone = telefone !== undefined ? (telefone || '').trim() : hospitalAtual.telefone;

    db.prepare(`
      UPDATE hospitais SET
        nome = ?,
        zona = ?,
        rota_id = ?,
        endereco = ?,
        telefone = ?
      WHERE id = ?
    `).run(novoNome, novaZona, novaRotaId, novoEndereco, novoTelefone, id);

    let rotaNome = '';
    if (novaRotaId) {
      const rotaObj = db.prepare('SELECT nome FROM rotas WHERE id = ?').get(novaRotaId);
      if (rotaObj) rotaNome = rotaObj.nome;
    }

    // Atualiza pacientes vinculados a este hospital
    db.prepare(`
      UPDATE pacientes SET hospital = ?, zona = ?, rota = ?
      WHERE hospital_id = ?
    `).run(novoNome, novaZona, rotaNome, id);

    const atualizado = db.prepare(`
      SELECT h.*, r.nome as rota_nome,
             (SELECT COUNT(*) FROM pacientes p WHERE p.hospital_id = h.id OR (p.hospital_id IS NULL AND LOWER(p.hospital) = LOWER(h.nome))) as total_pacientes
      FROM hospitais h
      LEFT JOIN rotas r ON h.rota_id = r.id
      WHERE h.id = ?
    `).get(id);

    res.json(atualizado);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Excluir hospital
app.delete('/api/hospitais/:id', (req, res) => {
  try {
    const { id } = req.params;
    const hospital = db.prepare('SELECT * FROM hospitais WHERE id = ?').get(id);
    if (!hospital) {
      return res.status(404).json({ error: 'Hospital não encontrado' });
    }

    db.prepare('UPDATE pacientes SET hospital_id = NULL WHERE hospital_id = ?').run(id);
    db.prepare('DELETE FROM hospitais WHERE id = ?').run(id);

    res.json({ message: 'Hospital excluído com sucesso' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// PACIENTES (com Hospital, Rota e Zona)
// ==========================================

// Listar todos os pacientes com zona e rota
app.get('/api/pacientes', (req, res) => {
  try {
    const pacientes = db.prepare(`
      SELECT p.*,
             COALESCE(h.nome, p.hospital) as hospital,
             COALESCE(h.zona, p.zona, 'Fortaleza') as zona,
             COALESCE(r.nome, p.rota, '') as rota,
             COUNT(DISTINCT a.id) as total_anexos,
             (SELECT COUNT(*) FROM observacoes WHERE paciente_id = p.id) as total_observacoes
      FROM pacientes p
      LEFT JOIN hospitais h ON p.hospital_id = h.id
      LEFT JOIN rotas r ON h.rota_id = r.id
      LEFT JOIN anexos a ON p.id = a.paciente_id
      GROUP BY p.id
      ORDER BY p.id DESC
    `).all();
    res.json(pacientes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Buscar paciente por ID com anexos e histórico de observações
app.get('/api/pacientes/:id', (req, res) => {
  try {
    const paciente = db.prepare(`
      SELECT p.*,
             COALESCE(h.nome, p.hospital) as hospital,
             COALESCE(h.zona, p.zona, 'Fortaleza') as zona,
             COALESCE(r.nome, p.rota, '') as rota
      FROM pacientes p
      LEFT JOIN hospitais h ON p.hospital_id = h.id
      LEFT JOIN rotas r ON h.rota_id = r.id
      WHERE p.id = ?
    `).get(req.params.id);

    if (!paciente) {
      return res.status(404).json({ error: 'Paciente não encontrado' });
    }
    const anexos = db.prepare('SELECT * FROM anexos WHERE paciente_id = ?').all(req.params.id);
    const observacoes = db.prepare(`
      SELECT * FROM observacoes
      WHERE paciente_id = ?
      ORDER BY criado_em DESC, id DESC
    `).all(req.params.id);

    res.json({ ...paciente, anexos, observacoes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Criar novo paciente
app.post('/api/pacientes', (req, res) => {
  try {
    const { nome, cpf, contato, consultor, hospital, hospital_id, zona, rota, status, dataPrevista, prontuarios } = req.body;
    
    if (!nome) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }

    const hospInfo = resolverDadosHospital(hospital_id, hospital, zona, rota);

    const stmt = db.prepare(`
      INSERT INTO pacientes (nome, cpf, contato, consultor, hospital, hospital_id, zona, rota, status, dataPrevista, prontuarios)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      nome,
      cpf || '',
      contato || '',
      consultor || '',
      hospInfo.hospital,
      hospInfo.hospital_id,
      hospInfo.zona,
      hospInfo.rota,
      status || 'Em Análise',
      dataPrevista || '',
      prontuarios || ''
    );

    const novoId = result.lastInsertRowid;

    // Se houver prontuário/observação inicial, grava no histórico de observações
    if (prontuarios && prontuarios.trim()) {
      db.prepare(`
        INSERT INTO observacoes (paciente_id, autor, texto)
        VALUES (?, ?, ?)
      `).run(novoId, (consultor && consultor.trim()) ? consultor.trim() : 'Cadastro Inicial', prontuarios.trim());
    }

    const novo = db.prepare(`
      SELECT p.*,
             COALESCE(h.nome, p.hospital) as hospital,
             COALESCE(h.zona, p.zona, 'Fortaleza') as zona,
             COALESCE(r.nome, p.rota, '') as rota,
             0 as total_anexos,
             (SELECT COUNT(*) FROM observacoes WHERE paciente_id = p.id) as total_observacoes
      FROM pacientes p
      LEFT JOIN hospitais h ON p.hospital_id = h.id
      LEFT JOIN rotas r ON h.rota_id = r.id
      WHERE p.id = ?
    `).get(novoId);

    res.status(201).json(novo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Atualizar paciente
app.put('/api/pacientes/:id', (req, res) => {
  try {
    const { nome, cpf, contato, consultor, hospital, hospital_id, zona, rota, status, dataPrevista, prontuarios, novaObservacao, autorObservacao } = req.body;
    const { id } = req.params;

    const paciente = db.prepare('SELECT * FROM pacientes WHERE id = ?').get(id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente não encontrado' });
    }

    const targetHospId = hospital_id !== undefined ? hospital_id : paciente.hospital_id;
    const targetHospNome = hospital !== undefined ? hospital : paciente.hospital;
    const targetZona = zona !== undefined ? zona : paciente.zona;
    const targetRota = rota !== undefined ? rota : paciente.rota;

    const hospInfo = resolverDadosHospital(targetHospId, targetHospNome, targetZona, targetRota);

    const stmt = db.prepare(`
      UPDATE pacientes SET
        nome = ?,
        cpf = ?,
        contato = ?,
        consultor = ?,
        hospital = ?,
        hospital_id = ?,
        zona = ?,
        rota = ?,
        status = ?,
        dataPrevista = ?,
        prontuarios = ?
      WHERE id = ?
    `);

    // Define texto de prontuarios atual
    let textoProntuarios = prontuarios !== undefined ? prontuarios : paciente.prontuarios;

    // Se foi enviada uma nova observação específica
    if (novaObservacao && novaObservacao.trim()) {
      const autorObs = (autorObservacao && autorObservacao.trim()) ? autorObservacao.trim() : (consultor || paciente.consultor || 'Consultor');
      db.prepare(`
        INSERT INTO observacoes (paciente_id, autor, texto)
        VALUES (?, ?, ?)
      `).run(id, autorObs, novaObservacao.trim());
      textoProntuarios = novaObservacao.trim();
    } else if (prontuarios !== undefined && prontuarios.trim() && prontuarios.trim() !== (paciente.prontuarios || '').trim()) {
      // Se o campo prontuarios foi alterado no formulário direto
      const autorObs = (consultor && consultor.trim()) ? consultor.trim() : (paciente.consultor || 'Consultor');
      db.prepare(`
        INSERT INTO observacoes (paciente_id, autor, texto)
        VALUES (?, ?, ?)
      `).run(id, autorObs, prontuarios.trim());
    }

    stmt.run(
      nome !== undefined ? nome : paciente.nome,
      cpf !== undefined ? cpf : paciente.cpf,
      contato !== undefined ? contato : paciente.contato,
      consultor !== undefined ? consultor : paciente.consultor,
      hospInfo.hospital,
      hospInfo.hospital_id,
      hospInfo.zona,
      hospInfo.rota,
      status !== undefined ? status : paciente.status,
      dataPrevista !== undefined ? dataPrevista : paciente.dataPrevista,
      textoProntuarios,
      id
    );

    const atualizado = db.prepare(`
      SELECT p.*,
             COALESCE(h.nome, p.hospital) as hospital,
             COALESCE(h.zona, p.zona, 'Fortaleza') as zona,
             COALESCE(r.nome, p.rota, '') as rota,
             (SELECT COUNT(*) FROM anexos WHERE paciente_id = p.id) as total_anexos,
             (SELECT COUNT(*) FROM observacoes WHERE paciente_id = p.id) as total_observacoes
      FROM pacientes p
      LEFT JOIN hospitais h ON p.hospital_id = h.id
      LEFT JOIN rotas r ON h.rota_id = r.id
      WHERE p.id = ?
    `).get(id);

    res.json(atualizado);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Excluir paciente
app.delete('/api/pacientes/:id', (req, res) => {
  try {
    const { id } = req.params;
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

// ==========================================
// ANEXOS
// ==========================================

// Upload de anexo
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

// ==========================================
// HISTÓRICO DE OBSERVAÇÕES / PRONTUÁRIOS
// ==========================================

// Listar histórico de observações de um paciente
app.get('/api/pacientes/:id/observacoes', (req, res) => {
  try {
    const { id } = req.params;
    const observacoes = db.prepare(`
      SELECT * FROM observacoes
      WHERE paciente_id = ?
      ORDER BY criado_em DESC, id DESC
    `).all(id);
    res.json(observacoes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Adicionar nova observação no histórico do paciente
app.post('/api/pacientes/:id/observacoes', (req, res) => {
  try {
    const { id } = req.params;
    const { autor, texto } = req.body;
    if (!texto || !texto.trim()) {
      return res.status(400).json({ error: 'O texto da observação é obrigatório' });
    }
    const paciente = db.prepare('SELECT * FROM pacientes WHERE id = ?').get(id);
    if (!paciente) {
      return res.status(404).json({ error: 'Paciente não encontrado' });
    }

    const autorFinal = (autor && autor.trim()) ? autor.trim() : (paciente.consultor || 'Consultor');

    const stmt = db.prepare(`
      INSERT INTO observacoes (paciente_id, autor, texto)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(id, autorFinal, texto.trim());

    // Atualiza campo prontuarios no paciente com a anotação mais recente
    db.prepare('UPDATE pacientes SET prontuarios = ? WHERE id = ?').run(texto.trim(), id);

    const nova = db.prepare('SELECT * FROM observacoes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(nova);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Excluir observação individual
app.delete('/api/observacoes/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM observacoes WHERE id = ?').run(id);
    res.json({ message: 'Observação excluída com sucesso' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ROTINA EXTERNO (Cronograma Diário e Feedback)
// ==========================================

// Listar rotinas diárias (opcionalmente filtrando por intervalo de datas ?inicio=YYYY-MM-DD&fim=YYYY-MM-DD)
app.get('/api/rotinas', (req, res) => {
  try {
    const { inicio, fim } = req.query;
    let query = 'SELECT * FROM rotinas';
    const params = [];

    if (inicio && fim) {
      query += ' WHERE data >= ? AND data <= ?';
      params.push(inicio, fim);
    } else if (inicio) {
      query += ' WHERE data >= ?';
      params.push(inicio);
    }
    query += ' ORDER BY data ASC';

    const rotinas = db.prepare(query).all(...params);
    res.json(rotinas);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obter rotina de um dia específico
app.get('/api/rotinas/:data', (req, res) => {
  try {
    const { data } = req.params;
    const rotina = db.prepare('SELECT * FROM rotinas WHERE data = ?').get(data);
    if (!rotina) {
      return res.json({
        data,
        dia_semana: '',
        consultor: '',
        rotina_programada: '',
        feedback: '',
        status: 'Planejado'
      });
    }
    res.json(rotina);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Salvar / Atualizar rotina diária (Upsert com ON CONFLICT)
app.post('/api/rotinas', (req, res) => {
  try {
    const { data, dia_semana, consultor, rotina_programada, feedback, status } = req.body;
    if (!data) {
      return res.status(400).json({ error: 'A data da rotina é obrigatória (formato YYYY-MM-DD)' });
    }

    const stmt = db.prepare(`
      INSERT INTO rotinas (data, dia_semana, consultor, rotina_programada, feedback, status, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(data) DO UPDATE SET
        dia_semana = excluded.dia_semana,
        consultor = excluded.consultor,
        rotina_programada = excluded.rotina_programada,
        feedback = excluded.feedback,
        status = excluded.status,
        atualizado_em = CURRENT_TIMESTAMP
    `);

    stmt.run(
      data,
      dia_semana || '',
      consultor || '',
      rotina_programada !== undefined ? rotina_programada : '',
      feedback !== undefined ? feedback : '',
      status || 'Planejado'
    );

    const salva = db.prepare('SELECT * FROM rotinas WHERE data = ?').get(data);
    res.json(salva);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Excluir rotina diária
app.delete('/api/rotinas/:data', (req, res) => {
  try {
    const { data } = req.params;
    db.prepare('DELETE FROM rotinas WHERE data = ?').run(data);
    res.json({ message: 'Rotina diária removida com sucesso' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Inicia servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
