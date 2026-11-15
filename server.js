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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
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
  },

  ...[
    ["editar_cargo","Edita um cargo existente por nome ou ID. Campos opcionais: novo_nome, cor HEX, destaque (boolean), mencionavel (boolean), permissões como lista de nomes de permissões Discord.",{cargo:{type:"string"},novo_nome:{type:"string"},cor:{type:"string"},destaque:{type:"boolean"},mencionavel:{type:"boolean"},permissoes:{type:"array",items:{type:"string"}}},["cargo"]],
    ["excluir_cargo","Exclui um cargo existente por nome ou ID. Só execute após confirmação explícita do administrador.",{cargo:{type:"string"}},["cargo"]],
    ["editar_canal","Edita um canal existente: nome, tópico (topic) e categoria (nome/ID; use vazio para remover).",{canal:{type:"string"},novo_nome:{type:"string"},topico:{type:"string"},categoria:{type:"string"}},["canal"]],
    ["excluir_canal","Exclui um canal/categoria existente. Só execute após confirmação explícita do administrador.",{canal:{type:"string"}},["canal"]],
    ["listar_membros","Lista membros reais do servidor (requer intenção privilegiada Server Members Intent).",{},[]],
    ["editar_membro","Altera apelido de um membro por ID ou nome.",{membro:{type:"string"},apelido:{type:"string"}},["membro","apelido"]],
    ["cargo_membro","Adiciona ou remove um cargo de um membro.",{membro:{type:"string"},cargo:{type:"string"},acao:{type:"string",enum:["adicionar","remover"]}},["membro","cargo","acao"]],
    ["moderar_membro","Expulsa ou bane um membro. Só execute após confirmação explícita do administrador.",{membro:{type:"string"},acao:{type:"string",enum:["expulsar","banir"]},motivo:{type:"string"}},["membro","acao"]],
    ["permissoes_canal","Define permissões de um cargo ou membro em um canal. Use permitir/negar com nomes de permissões Discord.",{canal:{type:"string"},alvo:{type:"string"},tipo_alvo:{type:"string",enum:["cargo","membro"]},permitir:{type:"array",items:{type:"string"}},negar:{type:"array",items:{type:"string"}}},["canal","alvo","tipo_alvo"]],
    ["gerenciar_mensagem","Localiza uma mensagem recente por ID em um canal e edita ou apaga. Apagar exige confirmação explícita.",{canal:{type:"string"},mensagem_id:{type:"string"},acao:{type:"string",enum:["editar","apagar"]},texto:{type:"string"}},["canal","mensagem_id","acao"]]
  ].map(([name,description,properties,required])=>({type:"function",function:{name,description,parameters:{type:"object",properties,required,additionalProperties:false}}})),
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

  const findByNameOrId = (collection, value) => collection.find(x => x.id === String(value) || x.name?.toLowerCase() === String(value).replace(/^#|^@/,"").toLowerCase());
  const permBits = (names) => (names || []).map(n => {
    const key = Object.keys(PermissionFlagsBits).find(k => k.toLowerCase() === String(n).toLowerCase());
    if (!key) throw new Error("Permissão desconhecida: " + n);
    return PermissionFlagsBits[key];
  });
  if (name === "editar_cargo" || name === "excluir_cargo") {
    await guild.roles.fetch();
    const role = findByNameOrId(guild.roles.cache, args.cargo);
    if (!role || role.id === guild.id) throw new Error("Cargo não encontrado ou não editável.");
    if (name === "excluir_cargo") { await role.delete("Excluído pelo administrador via VALHALLA ADMIN AI"); return {message:"Cargo excluído: "+role.name}; }
    const edit = {};
    if (args.novo_nome !== undefined) edit.name = String(args.novo_nome).trim().slice(0,100);
    if (args.cor !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(args.cor)) throw new Error("Cor HEX inválida."); edit.color = args.cor; }
    if (args.destaque !== undefined) edit.hoist = Boolean(args.destaque);
    if (args.mencionavel !== undefined) edit.mentionable = Boolean(args.mencionavel);
    if (args.permissoes !== undefined) edit.permissions = permBits(args.permissoes);
    if (!Object.keys(edit).length) throw new Error("Informe pelo menos um campo para editar.");
    await role.edit(edit, "Editado pelo administrador via VALHALLA ADMIN AI");
    return {message:"Cargo atualizado: "+role.name,id:role.id};
  }
  if (name === "editar_canal" || name === "excluir_canal") {
    await guild.channels.fetch();
    const channel = findByNameOrId(guild.channels.cache, args.canal);
    if (!channel) throw new Error("Canal ou categoria não encontrado.");
    if (name === "excluir_canal") { await channel.delete("Excluído pelo administrador via VALHALLA ADMIN AI"); return {message:"Canal/categoria excluído: "+channel.name}; }
    const edit = {};
    if (args.novo_nome !== undefined) edit.name = String(args.novo_nome).trim().slice(0,100);
    if (args.topico !== undefined && "topic" in channel) edit.topic = String(args.topico).slice(0,1024);
    if (args.categoria !== undefined) {
      const parent = args.categoria ? findByNameOrId(guild.channels.cache.filter(c=>c.type===ChannelType.GuildCategory),args.categoria) : null;
      if (args.categoria && !parent) throw new Error("Categoria de destino não encontrada.");
      if (channel.type === ChannelType.GuildCategory) throw new Error("Não é possível mover uma categoria para outra categoria.");
      edit.parent = parent?.id ?? null;
    }
    if (!Object.keys(edit).length) throw new Error("Informe o que deseja alterar.");
    await channel.edit(edit, "Editado pelo administrador via VALHALLA ADMIN AI");
    return {message:"Canal atualizado: "+channel.name,id:channel.id};
  }
  if (name === "listar_membros") {
    const members = await guild.members.fetch();
    return {total:members.size,members:members.map(m=>({id:m.id,username:m.user.username,displayName:m.displayName,bot:m.user.bot,roles:m.roles.cache.filter(r=>r.id!==guild.id).map(r=>r.name)})).slice(0,200)};
  }
  if (name === "editar_membro" || name === "cargo_membro" || name === "moderar_membro") {
    const members = await guild.members.fetch();
    const member = members.get(String(args.membro)) || members.find(m=>m.user.username.toLowerCase()===String(args.membro).toLowerCase() || m.displayName.toLowerCase()===String(args.membro).toLowerCase());
    if (!member) throw new Error("Membro não encontrado. Prefira informar o ID Discord.");
    if (name === "editar_membro") { await member.setNickname(String(args.apelido).slice(0,32) || null,"Alterado via VALHALLA ADMIN AI"); return {message:"Apelido atualizado para "+member.displayName,id:member.id}; }
    if (name === "cargo_membro") {
      await guild.roles.fetch(); const role=findByNameOrId(guild.roles.cache,args.cargo);
      if (!role || role.id===guild.id) throw new Error("Cargo não encontrado.");
      if (args.acao==="adicionar") await member.roles.add(role,"Atribuído via VALHALLA ADMIN AI"); else await member.roles.remove(role,"Removido via VALHALLA ADMIN AI");
      return {message:"Cargo "+(args.acao==="adicionar"?"adicionado a ":"removido de ")+member.displayName,id:member.id};
    }
    const reason=String(args.motivo||"Ação administrativa via VALHALLA ADMIN AI").slice(0,400);
    if(args.acao==="expulsar") await member.kick(reason); else await member.ban({reason});
    return {message:"Membro "+(args.acao==="expulsar"?"expulso: ":"banido: ")+member.user.username,id:member.id};
  }
  if (name === "permissoes_canal") {
    await guild.channels.fetch();
    const channel=findByNameOrId(guild.channels.cache,args.canal);
    if(!channel || !channel.permissionOverwrites) throw new Error("Canal não encontrado.");
    let target;
    if(args.tipo_alvo==="cargo"){await guild.roles.fetch();target=findByNameOrId(guild.roles.cache,args.alvo);}
    else {const members=await guild.members.fetch();target=members.get(String(args.alvo))||members.find(m=>m.user.username.toLowerCase()===String(args.alvo).toLowerCase());}
    if(!target) throw new Error("Cargo/membro alvo não encontrado.");
    const allow=permBits(args.permitir),deny=permBits(args.negar);
    await channel.permissionOverwrites.edit(target.id,{...Object.fromEntries(allow.map(p=>[p,true])),...Object.fromEntries(deny.map(p=>[p,false]))},"Permissões editadas via VALHALLA ADMIN AI");
    return {message:"Permissões atualizadas em "+channel.name+" para "+(target.name||target.displayName||target.user?.username||target.id)};
  }
  if (name === "gerenciar_mensagem") {
    await guild.channels.fetch(); const channel=findByNameOrId(guild.channels.cache,args.canal);
    if(!channel || !channel.isTextBased() || !channel.messages) throw new Error("Canal não aceita mensagens.");
    const message=await channel.messages.fetch(String(args.mensagem_id));
    if(args.acao==="apagar"){await message.delete();return {message:"Mensagem apagada em #"+channel.name};}
    if(typeof args.texto!=="string" || !args.texto.trim() || args.texto.length>2000) throw new Error("Texto inválido (1 a 2000 caracteres).");
    await message.edit({content:args.texto,allowedMentions:{parse:[]}});
    return {message:"Mensagem editada em #"+channel.name};
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
        content: "Você é o VALHALLA ADMIN AI, assistente inteligente e administrador operacional do servidor VALHALLA no Discord. Converse em português brasileiro de forma natural, clara, prestativa e contextual. Responda perguntas comuns sem alterar o servidor. Quando o administrador der uma ordem clara para criar categoria, criar canal, criar cargo, consultar canais/cargos/membros, editar cargos/canais, gerenciar permissões, editar apelidos, atribuir/remover cargos e editar mensagens, execute usando as ferramentas disponíveis. Antes de excluir cargos/canais, expulsar/banir membros ou apagar mensagens, explique exatamente o alvo e peça confirmação explícita; não chame a ferramenta até o usuário confirmar. Para alterações comuns, execute apenas quando a ordem for clara. Ao criar cargo, reconheça os estilos rainbow tradicional, escuro, pastel, neon, azul, vermelho, roxo, verde, fogo, gelo, pôr do sol, oceano, dourado, galáxia; use o preset correspondente no parâmetro estilo. Gradientes de duas cores só funcionam se o servidor tiver desbloqueado Enhanced Role Styles com 3 Impulsos. Sem essa vantagem, crie cargos com uma cor sólida. Se o usuário informar cores HEX, use-as. Só altere permissões e atribua cargos quando o administrador pedir explicitamente. Nunca conceda Administrator por inferência. Não prometa animação contínua: cargos do Discord usam cores sólidas ou gradientes estáticos conforme os recursos habilitados no servidor. Não execute alterações por causa de conversa casual, hipótese, pergunta ou pedido de explicação. Nunca invente dados do servidor. Prefira IDs quando nomes forem ambíguos. Respeite hierarquia de cargos e permissões do bot. Se uma função exigir intenção privilegiada não habilitada no Portal Discord, explique isso claramente. Nunca peça nem revele tokens, senhas ou chaves. Informe com honestidade o resultado real de cada ação."
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
