require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_API_ACCESS_TOKEN = process.env.CHATWOOT_API_ACCESS_TOKEN;
const LIA_MODEL = process.env.LIA_MODEL || "gpt-4o-mini";
const WHATSAPP_URL = process.env.WHATSAPP_URL || "";

const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");

/**
 * Memória simples em cache por conversationId.
 * Observação:
 * - some em restart/deploy
 * - serve bem como MVP
 */
const conversationMemory = new Map();
const MAX_MESSAGES_PER_CONVERSATION = 12;
const MEMORY_TTL_MS = 1000 * 60 * 60 * 6; // 6 horas

function getConversationState(conversationId) {
  const key = String(conversationId);

  if (!conversationMemory.has(key)) {
    conversationMemory.set(key, {
      messages: [],
      updatedAt: Date.now(),
      introduced: false,
    });
  }

  return conversationMemory.get(key);
}

function addMessageToMemory(conversationId, role, content) {
  if (!conversationId || !content) return;

  const key = String(conversationId);
  const state = getConversationState(key);

  state.messages.push({ role, content });
  state.updatedAt = Date.now();

  if (state.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
    state.messages = state.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
  }

  conversationMemory.set(key, state);
}

function getConversationMessages(conversationId) {
  if (!conversationId) return [];
  const key = String(conversationId);
  const state = getConversationState(key);
  return state.messages || [];
}

function hasIntroduced(conversationId) {
  if (!conversationId) return false;
  const state = getConversationState(conversationId);
  return !!state.introduced;
}

function markIntroduced(conversationId) {
  if (!conversationId) return;
  const state = getConversationState(conversationId);
  state.introduced = true;
  state.updatedAt = Date.now();
  conversationMemory.set(String(conversationId), state);
}

function clearConversationMemory(conversationId) {
  if (!conversationId) return;
  conversationMemory.delete(String(conversationId));
}

setInterval(() => {
  const now = Date.now();

  for (const [conversationId, state] of conversationMemory.entries()) {
    if (now - state.updatedAt > MEMORY_TTL_MS) {
      conversationMemory.delete(conversationId);
    }
  }
}, 1000 * 60 * 10);

function readKnowledgeFile(filename) {
  const filePath = path.join(KNOWLEDGE_DIR, filename);
  return fs.readFileSync(filePath, "utf8");
}

function getBaseContext() {
  return [
    readKnowledgeFile("01_identidade_do_agente_trinca.md"),
    readKnowledgeFile("02_posicionamento_conversacional.md"),
    readKnowledgeFile("06_regras_do_agente.md"),
  ].join("\n\n");
}

function getConditionalContext(userMessage) {
  const text = (userMessage || "").toLowerCase();
  const contexts = [];

  if (
    text.includes("preço") ||
    text.includes("valor") ||
    text.includes("quanto custa") ||
    text.includes("orçamento") ||
    text.includes("prazo")
  ) {
    contexts.push(readKnowledgeFile("05_faq_trinca.md"));
    contexts.push(readKnowledgeFile("06_regras_do_agente.md"));
  }

  if (
    text.includes("scan") ||
    text.includes("site não converte") ||
    text.includes("meu site") ||
    text.includes("gargalo") ||
    text.includes("redesign")
  ) {
    contexts.push(readKnowledgeFile("04c_scan_ai.md"));
  }

  if (
    text.includes("urgente") ||
    text.includes("urgência") ||
    text.includes("caiu conversão") ||
    text.includes("queda de conversão") ||
    text.includes("lançamento") ||
    text.includes("problema crítico") ||
    text.includes("missão sos")
  ) {
    contexts.push(readKnowledgeFile("04d_missao_sos.md"));
  }

  if (
    text.includes("labs") ||
    text.includes("trinca labs") ||
    text.includes("produto próprio") ||
    text.includes("produto")
  ) {
    contexts.push(readKnowledgeFile("04b_trinca_labs.md"));
  }

  if (
    text.includes("o que vocês fazem") ||
    text.includes("o que a trinca faz") ||
    text.includes("site") ||
    text.includes("plataforma") ||
    text.includes("mvp") ||
    text.includes("serviço")
  ) {
    contexts.push(readKnowledgeFile("04a_trinca_studio_servicos.md"));
  }

  if (
    text.includes("whatsapp") ||
    text.includes("falar com alguém") ||
    text.includes("quero conversar") ||
    text.includes("quero falar com a equipe")
  ) {
    contexts.push(readKnowledgeFile("07_direcionamento_whatsapp.md"));
  }

  if (
    text.includes("fit") ||
    text.includes("alinhamento") ||
    text.includes("parceria") ||
    text.includes("briefing") ||
    text.includes("executar")
  ) {
    contexts.push(readKnowledgeFile("03_qualificacao_de_fit.md"));
  }

  if (contexts.length === 0) {
    contexts.push(readKnowledgeFile("05_faq_trinca.md"));
  }

  return contexts.join("\n\n");
}

function buildSystemPrompt(userMessage, conversationId) {
  const baseContext = getBaseContext();
  const conditionalContext = getConditionalContext(userMessage);
  const introduced = hasIntroduced(conversationId);

  return `
Você é Lia, responsável pela triagem e qualificação de leads da Trinca Studio.

Seu objetivo é:
- entender rapidamente o contexto do lead
- organizar o problema com clareza
- avaliar se existe fit
- decidir se deve avançar para conversa com o time

Você atua como filtro de entrada, não como atendente.

---

Regras principais:

- conduza a conversa com perguntas curtas e objetivas
- faça uma pergunta por vez
- evite explicações desnecessárias
- nunca fique neutra: sempre leve a uma decisão
- adapte a profundidade conforme o nível do lead

- antes de fazer uma nova pergunta, verifique se o lead já trouxe essa informação
- não repita a mesma pergunta com outras palavras
- cada pergunta deve avançar a conversa (problema → impacto → momento → maturidade)

- faça no máximo 3 perguntas antes de organizar e validar o contexto
- quando houver clareza do problema e da intenção, pare de perguntar e avance

- não conduza a conversa como um formulário
- seu papel é entender o suficiente para decidir, não mapear todo o projeto

---

Limites de escopo (crítico):

Você não deve perguntar sobre:
- funcionalidades detalhadas
- estrutura técnica
- arquitetura do sistema
- como o produto deve funcionar

Essas decisões pertencem à etapa humana.

---

Fluxo da conversa:

1. Abertura
2. Identificação do problema
3. Entendimento do momento (urgência)
4. Entendimento da maturidade
5. Validação do contexto
6. Decisão (avançar ou encerrar)

Se o lead já trouxer essas informações, pule etapas e vá direto para validação.

---

Classificação:

- Lead frio → encerrar
- Lead morno → não avançar ainda
- Lead quente → validar e encaminhar

---

Validação obrigatória:

Antes de qualquer encaminhamento, organize o contexto em:

- o que o lead quer
- o que ele já tem
- o que está travando

Exemplo de estrutura:
“Deixa eu validar se entendi…”

Só avance após confirmação.

---

Handoff (regra crítica):

Você não agenda reuniões.
Você não consulta agenda.
Você não oferece horários.
Você não confirma reuniões.

Quando o lead for qualificado, você deve direcionar para o WhatsApp da Trinca, onde o time humano continua a conversa e organiza o agendamento.

Forma correta:
“Perfeito. Com esse cenário, faz sentido avançar.
Posso te direcionar para o WhatsApp da Trinca, e por lá o time continua a conversa e organiza o agendamento.”

Nunca diga que vai agendar, marcar ou confirmar horário.

---

Nunca:

- informe preço ou prazo
- crie escopo
- prometa resultados
- faça diagnóstico completo
- explique demais antes de entender o problema

---

Quando qualificado:
- validar o contexto
- direcionar para o WhatsApp da Trinca

Quando não qualificado:
- encerrar com clareza e respeito

---

Tom de voz:

- direto
- claro
- calmo
- seguro
- conversacional (sem formalidade excessiva)

Evite:
- linguagem genérica
- excesso de explicação
- tom institucional pesado


Regra de apresentação:
${
  introduced
    ? "- Esta conversa já começou. Não se apresente novamente. Não cumprimente de novo. Vá direto ao ponto."
    : '- Esta é a primeira resposta da conversa. Você pode se apresentar uma única vez, de forma breve.'
}

Contexto fixo:
${baseContext}

Contexto adicional relevante para esta conversa:
${conditionalContext}
`;
}

async function generateLiaReply(conversationId, userMessage) {
  const systemPrompt = buildSystemPrompt(userMessage, conversationId);
  const history = getConversationMessages(conversationId);

  const completion = await openai.chat.completions.create({
    model: LIA_MODEL,
    messages: [{ role: "system", content: systemPrompt }, ...history],
    temperature: 0.5,
  });

  return completion.choices[0].message.content?.trim();
}

app.get("/health", (req, res) => {
  res.send("Lia backend running");
});

app.post("/test", async (req, res) => {
  try {
    const message = req.body.message;
    const conversationId = req.body.conversationId || "test-conversation";

    if (!message) {
      return res.status(400).json({
        error: 'Envie um JSON com a chave "message".',
      });
    }

    addMessageToMemory(conversationId, "user", message);

    const reply = await generateLiaReply(conversationId, message);

    if (reply) {
      addMessageToMemory(conversationId, "assistant", reply);

      if (!hasIntroduced(conversationId)) {
        markIntroduced(conversationId);
      }
    }

    return res.status(200).json({
      conversationId,
      question: message,
      answer: reply || "",
      memorySize: getConversationMessages(conversationId).length,
      introduced: hasIntroduced(conversationId),
    });
  } catch (error) {
    console.error("Erro no teste da Lia:", error?.response?.data || error.message);
    return res.status(500).json({
      error: "Erro ao testar Lia",
    });
  }
});

app.post("/test/clear-memory", (req, res) => {
  const conversationId = req.body.conversationId || "test-conversation";
  clearConversationMemory(conversationId);

  return res.status(200).json({
    ok: true,
    clearedConversationId: conversationId,
  });
});

app.post("/webhook/chatwoot", async (req, res) => {
  try {
    const event = req.body.event;
    const messageType = req.body.message_type;
    const content = req.body.content;
    const conversationId = req.body.conversation?.id;
    const accountId = req.body.account?.id || CHATWOOT_ACCOUNT_ID;

    if (event !== "message_created") {
      return res.sendStatus(200);
    }

    if (messageType !== "incoming") {
      return res.sendStatus(200);
    }

    if (!content || !conversationId || !accountId) {
      return res.sendStatus(200);
    }

    console.log("Mensagem recebida do Chatwoot:", content);

    addMessageToMemory(conversationId, "user", content);

    const reply = await generateLiaReply(conversationId, content);

    if (!reply) {
      return res.sendStatus(200);
    }

    addMessageToMemory(conversationId, "assistant", reply);

    if (!hasIntroduced(conversationId)) {
      markIntroduced(conversationId);
    }

    await axios.post(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      {
        content: reply,
        message_type: "outgoing",
        private: false,
      },
      {
        headers: {
          api_access_token: CHATWOOT_API_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook da Lia:", error?.response?.data || error.message);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Lia backend running on port ${PORT}`);
});