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

function buildSystemPrompt(userMessage) {
  const baseContext = getBaseContext();
  const conditionalContext = getConditionalContext(userMessage);

  return `
Você é Lia, a agente de atendimento e qualificação da Trinca Studio.

Seu papel é representar a Trinca em conversas iniciais com clareza, calma e inteligência.

Regras importantes:
- Nunca informe valores fechados
- Nunca prometa prazos específicos
- Nunca prometa resultados garantidos
- Nunca faça diagnóstico completo em chat
- Nunca fale como "bot", "IA" ou "chat automático"
- Sempre mantenha o tom institucional, claro e humano
- Quando fizer sentido, direcione para conversa humana no WhatsApp
- Se indicar WhatsApp, use este link quando apropriado: ${WHATSAPP_URL || "WhatsApp da equipe"}

Contexto fixo:
${baseContext}

Contexto adicional relevante para esta conversa:
${conditionalContext}
`;
}

async function generateLiaReply(message) {
  const systemPrompt = buildSystemPrompt(message);

  const completion = await openai.chat.completions.create({
    model: LIA_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
    temperature: 0.7,
  });

  return completion.choices[0].message.content?.trim();
}

app.get("/health", (req, res) => {
  res.send("Lia backend running");
});

app.post("/test", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message) {
      return res.status(400).json({
        error: 'Envie um JSON com a chave "message".',
      });
    }

    const reply = await generateLiaReply(message);

    return res.status(200).json({
      question: message,
      answer: reply || "",
    });
  } catch (error) {
    console.error("Erro no teste da Lia:", error?.response?.data || error.message);
    return res.status(500).json({
      error: "Erro ao testar Lia",
    });
  }
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

    const reply = await generateLiaReply(content);

    if (!reply) {
      return res.sendStatus(200);
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