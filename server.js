const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require("discord.js");
const OpenAI = require("openai");

const required = ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "ADMIN_PASSWORD"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error("Variáveis obrigatórias ausentes:", missing.join(", "));
  process.exit(1);
}

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(",") : true }));
app.use(express.json({ limit: "30kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]
});
let discordReady = false;

discord.once("ready", () => {
  discordReady = true;
  console.log("Bot conectado como " + discord.user.tag);
});
discord.on("error", (error) => console.error("Discord:", error.message));
discord.login(process.env.DISCORD_BOT_TOKEN).catch((error) => {
  console.error("Falha ao conectar o bot:", error.message);
  process.exit(1);
});

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!supplied || supplied.length !== process.env.ADMIN_PASSWORD.length ||
      !require("crypto").timingSafeEqual(Buffer.from(supplied), Buffer.from(process.env.ADMIN_PASSWORD))) {
    return res.status(401).json({ error: "Não autorizado." });
  }
  next();
}

async function getGuild() {
  if (!discordReady) throw new Error("O bot ainda está conectando ao Discord.");
  const guild = await discord.guilds.fetch(process.env.DISCORD_GUILD_ID);
  return guild;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "VALHALLA ADMIN AI", discord: discordReady ? "online" : "connecting" });
});

app.get("/api/status", auth, async (_req, res) => {
  res.json({ ok: true, discord: discordReady ? "online" : "offline", guildId: process.env.DISCORD_GUILD_ID });
});

app.get("/api/discord/overview", auth, async (_req, res) => {
  try {
    const guild = await getGuild();
    await guild.channels.fetch();
    await guild.roles.fetch();
    res.json({
      name: guild.name,
      memberCount: guild.memberCount,
      channels: guild.channels.cache.map(c => ({ id: c.id, name: c.name, type: c.type })),
      roles: guild.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name, position: r.position }))
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "listar_canais",
      description: "Lista os canais do servidor VALHALLA.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "listar_cargos",
      description: "Lista os cargos e suas posições no servidor.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "criar_canal",
      description: "Prepara a criação de um canal de texto. A criação só ocorre após confirmação do administrador.",
      parameters: {
        type: "object",
        properties: {
          nome: { type: "string", description: "Nome simples do canal, sem #." },
          categoria: { type: "string", description: "Nome da categoria existente; opcional." }
        },
        required: ["nome"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "enviar_mensagem",
      description: "Prepara o envio de uma mensagem em um canal. O envio só ocorre após confirmação do administrador.",
      parameters: {
        type: "object",
        properties: {
          canal: { type: "string", description: "Nome ou ID do canal." },
          mensagem: { type: "string", description: "Texto a enviar." }
        },
        required: ["canal", "mensagem"],
        additionalProperties: false
      }
    }
  }
];

async function inspectTool(name, args) {
  const guild = await getGuild();
  if (name === "listar_canais") {
    await guild.channels.fetch();
    return { channels: guild.channels.cache.map(c => ({ id: c.id, name: c.name, type: c.type })) };
  }
  if (name === "listar_cargos") {
    await guild.roles.fetch();
    return { roles: guild.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name, position: r.position })) };
  }
  if (name === "criar_canal") {
    const nome = String(args.nome || "").trim().toLowerCase().replace(/[^a-z0-9áàâãéèêíïóôõöúçñ_-]/gi, "-").replace(/-+/g, "-").slice(0, 90);
    if (!nome) throw new Error("Nome de canal inválido.");
    let parentId;
    if (args.categoria) {
      await guild.channels.fetch();
      const parent = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === String(args.categoria).toLowerCase());
      if (!parent) throw new Error("Categoria não encontrada.");
      parentId = parent.id;
    }
    return { pending: true, action: "criar_canal", args: { nome, parentId }, summary: "Criar o canal #" + nome };
  }
  if (name === "enviar_mensagem") {
    const mensagem = String(args.mensagem || "").trim();
    if (!mensagem || mensagem.length > 1900) throw new Error("A mensagem deve ter entre 1 e 1900 caracteres.");
    await guild.channels.fetch();
    const channel = guild.channels.cache.find(c => (c.id === String(args.canal) || c.name.toLowerCase() === String(args.canal).replace(/^#/, "").toLowerCase()) && c.isTextBased() && c.isSendable());
    if (!channel) throw new Error("Canal de texto não encontrado ou sem permissão para enviar.");
    return { pending: true, action: "enviar_mensagem", args: { channelId: channel.id, mensagem }, summary: "Enviar mensagem em #" + channel.name };
  }
  throw new Error("Ação não permitida.");
}

async function executePending(pending) {
  const guild = await getGuild();
  if (pending.action === "criar_canal") {
    const channel = await guild.channels.create({
      name: pending.args.nome,
      type: ChannelType.GuildText,
      parent: pending.args.parentId || undefined,
      reason: "Solicitado pelo VALHALLA ADMIN AI e confirmado pelo administrador"
    });
    return { message: "Canal criado: #" + channel.name, id: channel.id };
  }
  if (pending.action === "enviar_mensagem") {
    const channel = await guild.channels.fetch(pending.args.channelId);
    if (!channel || !channel.isTextBased() || !channel.isSendable()) throw new Error("Canal indisponível.");
    await channel.send({ content: pending.args.mensagem, allowedMentions: { parse: [] } });
    return { message: "Mensagem enviada em #" + channel.name };
  }
  throw new Error("Ação pendente inválida.");
}

app.post("/api/assistant", auth, async (req, res) => {
  try {
    const prompt = String(req.body.message || "").trim();
    if (!prompt || prompt.length > 1500) return res.status(400).json({ error: "Envie uma mensagem de até 1500 caracteres." });
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [
        { role: "system", content: "Você é o assistente administrativo do servidor VALHALLA no Discord. Responda em português brasileiro, seja objetivo. Use ferramentas apenas quando o pedido exigir. Nunca invente membros, cargos ou canais. Você pode consultar canais e cargos. Para criar canal ou enviar mensagem, prepare a ação e aguarde confirmação explícita do administrador. Nunca solicite nem revele tokens, senhas ou chaves. Não altere cargos, permissões, membros ou configurações fora das ferramentas disponíveis." },
        { role: "user", content: prompt }
      ],
      tools: toolDefinitions,
      tool_choice: "auto"
    });
    const msg = completion.choices[0].message;
    if (msg.tool_calls?.length) {
      const results = [];
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments || "{}");
        const result = await inspectTool(call.function.name, args);
        results.push(result);
      }
      const pending = results.find(r => r.pending);
      if (pending) return res.json({ reply: "Posso executar esta ação: " + pending.summary + ". Confirme para continuar.", pendingAction: pending });
      return res.json({ reply: "Consultei o servidor: " + JSON.stringify(results) });
    }
    res.json({ reply: msg.content || "Não consegui gerar uma resposta." });
  } catch (error) {
    console.error("Assistant:", error.message);
    res.status(500).json({ error: "Não foi possível processar o comando.", detail: error.message });
  }
});

app.post("/api/confirm", auth, async (req, res) => {
  try {
    const pending = req.body.pendingAction;
    if (!pending || !["criar_canal", "enviar_mensagem"].includes(pending.action)) {
      return res.status(400).json({ error: "Ação pendente inválida." });
    }
    const result = await executePending(pending);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error("Confirm:", error.message);
    res.status(502).json({ error: "A ação não foi concluída.", detail: error.message });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log("VALHALLA ADMIN AI backend na porta " + port));
