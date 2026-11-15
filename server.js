const express = require("express");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require("discord.js");
const OpenAI = require("openai");

const required = ["GROQ_API_KEY", "DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "ADMIN_PASSWORD"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error("Variáveis obrigatórias ausentes:", missing.join(", "));
  process.exit(1);
}

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(",") : true }));
app.use(express.json({ limit: "30kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }));

const ai = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" });
const discord = new Client({
  intents: [GatewayIntentBits.Guilds]
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

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

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
      roles: guild.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name, position: r.position, colors: { primaryColor: r.colors.primaryColor, secondaryColor: r.colors.secondaryColor }, hoist: r.hoist }))
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
      name: "criar_cargo",
      description: "Cria imediatamente um cargo no servidor com cor sólida ou gradiente. Não concede permissões administrativas nem atribui o cargo a membros.",
      parameters: {
        type: "object",
        properties: {
          nome: { type: "string", description: "Nome do cargo." },
          estilo: { type: "string", enum: ["rainbow", "rainbow_escuro", "rainbow_pastel", "rainbow_neon", "rainbow_azul", "rainbow_vermelho", "rainbow_roxo", "rainbow_verde", "rainbow_fogo", "rainbow_gelo", "sunset", "oceano", "dourado", "galaxia"], description: "Estilo oficial: gradientes de duas cores (rainbow, escuro, pastel, neon, azul, vermelho, roxo, verde, fogo, gelo, pôr do sol, oceano, dourado, galáxia)." },
          cor: { type: "string", description: "Cor principal HEX personalizada; substitui a cor principal do preset." },
          cor_secundaria: { type: "string", description: "Segunda cor HEX personalizada; substitui a segunda cor do preset." },
          destaque: { type: "boolean", description: "Se verdadeiro, exibe os membros deste cargo separadamente na lista." }
        },
        required: ["nome"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "criar_categoria",
      description: "Cria imediatamente uma categoria no servidor quando o administrador solicitar.",
      parameters: {
        type: "object",
        properties: { nome: { type: "string", description: "Nome da categoria." } },
        required: ["nome"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "criar_canal",
      description: "Cria imediatamente um canal de texto quando o administrador solicitar. Se a categoria indicada ainda não existir, crie-a primeiro.",
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
      description: "Envia imediatamente uma mensagem no canal indicado quando o administrador solicitar.",
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
    return { roles: guild.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name, position: r.position, colors: { primaryColor: r.colors.primaryColor, secondaryColor: r.colors.secondaryColor }, hoist: r.hoist })) };
  }
  if (name === "criar_cargo") {
    const nome = String(args.nome || "").trim().slice(0, 100);
    if (!nome) throw new Error("Nome de cargo inválido.");
    const hexPattern = /^#[0-9A-Fa-f]{6}$/;
    const palettes = {
      rainbow: ["#FF0000", "#8A2BE2"],
      rainbow_escuro: ["#5B1647", "#172554"],
      rainbow_pastel: ["#FFB3C6", "#B8C0FF"],
      rainbow_neon: ["#FF00E5", "#00F5FF"],
      rainbow_azul: ["#001BFF", "#00C8FF"],
      rainbow_vermelho: ["#4A0000", "#FF1744"],
      rainbow_roxo: ["#240046", "#C77DFF"],
      rainbow_verde: ["#003B2F", "#7CFF00"],
      rainbow_fogo: ["#7F0000", "#FFD000"],
      rainbow_gelo: ["#B9F3FF", "#245BFF"],
      sunset: ["#FF512F", "#DD2476"],
      oceano: ["#001F54", "#00B4D8"],
      dourado: ["#7A4E00", "#FFD700"],
      galaxia: ["#12002F", "#7B2CBF"],
    };
    const preset = palettes[String(args.estilo || "").toLowerCase()] || null;
    const primary = args.cor ? String(args.cor).trim() : (preset ? preset[0] : "#5865F2");
    const secondary = args.cor_secundaria ? String(args.cor_secundaria).trim() : (preset ? preset[1] : null);
    if (!hexPattern.test(primary)) throw new Error("Cor principal inválida. Use hexadecimal, por exemplo #FF0000.");
    if (secondary && !hexPattern.test(secondary)) throw new Error("Cor secundária inválida. Use hexadecimal, por exemplo #0000FF.");
    const existing = guild.roles.cache.find(r => r.name.toLowerCase() === nome.toLowerCase());
    if (existing) throw new Error("Já existe um cargo com esse nome.");
    const options = {
      name: nome,
      color: primary,
      hoist: Boolean(args.destaque),
      mentionable: false,
      permissions: [],
      reason: "Solicitado pelo administrador via VALHALLA ADMIN AI"
    };
    if (secondary) options.colors = { primaryColor: primary, secondaryColor: secondary };
    const role = await guild.roles.create(options);
    const colorSummary = [primary, secondary].filter(Boolean).join(" → ");
    return { message: "Cargo criado: " + role.name + " (" + colorSummary + ").", id: role.id, color: role.hexColor };
  }
  if (name === "criar_categoria") {
    const nome = String(args.nome || "").trim().slice(0, 90);
    if (!nome) throw new Error("Nome de categoria inválido.");
    await guild.channels.fetch();
    const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === nome.toLowerCase());
    if (existing) return { message: "A categoria " + existing.name + " já existe.", id: existing.id };
    const created = await guild.channels.create({
      name: nome,
      type: ChannelType.GuildCategory,
      reason: "Solicitado pelo administrador via VALHALLA ADMIN AI"
    });
    return { message: "Categoria criada: " + created.name, id: created.id };
  }
  if (name === "criar_canal") {
    const nome = String(args.nome || "").trim().replace(/\\s+/g, "-").replace(/-+/g, "-").slice(0, 90);
    if (!nome) throw new Error("Nome de canal inválido.");
    let parentId;
    if (args.categoria) {
      await guild.channels.fetch();
      let parent = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === String(args.categoria).trim().toLowerCase());
      if (!parent) {
        parent = await guild.channels.create({
          name: String(args.categoria).trim().slice(0, 90),
          type: ChannelType.GuildCategory,
          reason: "Categoria criada automaticamente para atender ao pedido do administrador"
        });
      }
      parentId = parent.id;
    }
    const existingChannel = guild.channels.cache.find(c => c.name.toLowerCase() === nome.toLowerCase() && c.parentId === (parentId || null));
    if (existingChannel) return { message: "O canal #" + existingChannel.name + " já existe nessa categoria.", id: existingChannel.id };
    const channel = await guild.channels.create({
      name: nome,
      type: ChannelType.GuildText,
      parent: parentId || undefined,
      reason: "Solicitado pelo administrador via VALHALLA ADMIN AI"
    });
    return { message: "Canal criado: #" + channel.name, id: channel.id, category: args.categoria || null };
  }
  if (name === "enviar_mensagem") {
    const mensagem = String(args.mensagem || "").trim();
    if (!mensagem || mensagem.length > 1900) throw new Error("A mensagem deve ter entre 1 e 1900 caracteres.");
    await guild.channels.fetch();
    const channel = guild.channels.cache.find(c => (c.id === String(args.canal) || c.name.toLowerCase() === String(args.canal).replace(/^#/, "").toLowerCase()) && c.isTextBased() && c.isSendable());
    if (!channel) throw new Error("Canal de texto não encontrado ou sem permissão para enviar.");
    await channel.send({ content: mensagem, allowedMentions: { parse: [] } });
    return { message: "Mensagem enviada em #" + channel.name };
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

    const messages = [
      {
        role: "system",
        content: "Você é o VALHALLA ADMIN AI, assistente inteligente e parceiro administrativo do servidor VALHALLA no Discord. Converse em português brasileiro de forma natural, clara, prestativa e contextual. Responda perguntas comuns sem alterar o servidor. Quando o administrador der uma ordem clara para criar categoria, criar canal, criar cargo, consultar canais/cargos ou enviar mensagem, execute imediatamente usando as ferramentas disponíveis, sem pedir confirmação adicional. Ao criar cargo, reconheça os estilos rainbow tradicional, escuro, pastel, neon, azul, vermelho, roxo, verde, fogo, gelo, pôr do sol, oceano, dourado, galáxia; use o preset correspondente no parâmetro estilo. Gradientes de duas cores só funcionam se o servidor tiver desbloqueado Enhanced Role Styles com 3 Impulsos. Sem essa vantagem, crie cargos com uma cor sólida. Se o usuário informar cores HEX, use-as. Não conceda permissões ao cargo nem o atribua a membros. Não prometa animação contínua: cargos do Discord usam cores sólidas ou gradientes estáticos conforme os recursos habilitados no servidor. Não execute alterações por causa de conversa casual, hipótese, pergunta ou pedido de explicação. Nunca invente dados do servidor. Nunca peça nem revele tokens, senhas ou chaves. Informe com honestidade o resultado real de cada ação."
      },
      { role: "user", content: prompt }
    ];

    // Permite ao navegador enviar o histórico recente para manter o contexto da conversa.
    if (Array.isArray(req.body.history)) {
      const safeHistory = req.body.history.slice(-12).filter(m =>
        m && ["user", "assistant"].includes(m.role) &&
        typeof m.content === "string" && m.content.length <= 3000
      );
      messages.splice(1, 0, ...safeHistory);
    }

    for (let step = 0; step < 5; step++) {
      const completion = await ai.chat.completions.create({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
        messages,
        tools: toolDefinitions,
        tool_choice: "auto",
        temperature: 0.6,
        max_completion_tokens: 1800
      });

      const msg = completion.choices?.[0]?.message;
      if (!msg) throw new Error("O provedor de IA não retornou uma resposta.");

      if (!msg.tool_calls?.length) {
        return res.json({ reply: msg.content || "Não consegui gerar uma resposta." });
      }

      messages.push(msg);
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments || "{}");
        const result = await inspectTool(call.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result)
        });
      }
    }
    res.json({ reply: "Consegui consultar o servidor, mas a solicitação ficou complexa demais. Pode dividir em etapas?" });
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
