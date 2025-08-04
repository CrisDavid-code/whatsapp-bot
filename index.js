const { Boom } = require('@hapi/boom');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const axios = require('axios');
const { google } = require('googleapis');
const qrcode = require('qrcode-terminal');
require('dotenv').config();

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// ✅ Números autorizados
const numerosAutorizados = ['50239190651@s.whatsapp.net'];

// -------------------- PARSER LOCAL --------------------
function analizarTextoLocal(texto) {
  const regex = /^(.+?)\s+Q?(\d+(?:\.\d+)?)/i;
  const match = texto.match(regex);
  if (!match) return null;

  const descripcion = match[1].trim();
  const valor = parseFloat(match[2]);
  if (isNaN(valor)) return null;

  const categoria = clasificarCategoria(descripcion);
  return { descripcion, valor, categoria };
}

function clasificarCategoria(texto) {
  const lower = texto.toLowerCase();

  const alimentacion = ['comida', 'almuerzo', 'cena', 'restaurante', 'fresas', 'helado', 'chocobanano', 'pan', 'tamal', 'bebida', 'refresco', 'snack', 'hamburguesa', 'pollo', 'pizza'];
  const transporte = ['uber', 'gas', 'bus', 'taxi', 'combustible', 'pasaje'];
  const salud = ['doctor', 'medicina', 'farmacia', 'gimnasio', 'dentista'];
  const vestimenta = ['ropa', 'zapato', 'camisa', 'pantalón'];
  const entretenimiento = ['cine', 'netflix', 'spotify', 'juego', 'película'];
  const educacion = ['libro', 'colegiatura', 'curso', 'escuela', 'universidad'];
  const servicios = ['agua', 'luz', 'internet', 'saldo', 'teléfono', 'electricidad'];
  const hogar = ['renta', 'alquiler', 'despensa', 'mueble', 'silla', 'colchón'];

  if (contienePalabra(lower, alimentacion)) return 'Alimentación';
  if (contienePalabra(lower, transporte)) return 'Transporte';
  if (contienePalabra(lower, salud)) return 'Salud';
  if (contienePalabra(lower, vestimenta)) return 'Vestimenta';
  if (contienePalabra(lower, entretenimiento)) return 'Entretenimiento';
  if (contienePalabra(lower, educacion)) return 'Educación';
  if (contienePalabra(lower, servicios)) return 'Servicios';
  if (contienePalabra(lower, hogar)) return 'Hogar';

  return 'Otros';
}

function contienePalabra(texto, lista) {
  return lista.some(palabra => texto.includes(palabra));
}

// -------------------- GOOGLE SHEETS --------------------
async function registrarGasto(descripcion, valor, categoria) {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    keyFile: 'credenciales-google.json',
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const fecha = new Date().toLocaleDateString('es-ES');

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'A1',
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[fecha, descripcion, valor, categoria]] },
  });
}

async function obtenerDatosHoja() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    keyFile: 'credenciales-google.json',
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const respuesta = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'A2:D',
  });
  return respuesta.data.values || [];
}

async function calcularTotalGastos() {
  const datos = await obtenerDatosHoja();
  let total = 0;
  for (const fila of datos) {
    const valor = parseFloat(fila[2]);
    if (!isNaN(valor)) total += valor;
  }
  return total;
}

async function obtenerResumenUltimosGastos(cantidad = 5) {
  const datos = await obtenerDatosHoja();
  const ultimos = datos.slice(-cantidad).reverse();
  let resumen = "📊 *Últimos gastos registrados:*\n\n";
  for (const [fecha, descripcion, valor, categoria] of ultimos) {
    resumen += `🗕️ ${fecha} | 💬 ${descripcion} | 💰 Q${valor} | 🏷️ ${categoria}\n`;
  }
  return resumen;
}

// -------------------- GPT --------------------
async function analizarTexto(texto, intentos = 3) {
  const prompt = `
El siguiente texto representa un gasto.
Extrae la descripción, el valor y clasifícalo en una de las siguientes categorías:
- Alimentación
- Transporte
- Salud
- Vestimenta
- Entretenimiento
- Educación
- Servicios
- Hogar
- Otros
Ejemplo: {"descripcion":"Gimnasio", "valor":250, "categoria":"Salud"}
Texto: "${texto}"
`;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      const respuesta = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
        }
      );
      return JSON.parse(respuesta.data.choices[0].message.content);
    } catch (error) {
      if (error.response?.status === 429 && intento < intentos) {
        console.log(`⏳ Límite alcanzado, reintentando (${intento}/${intentos})...`);
        await new Promise(res => setTimeout(res, 3000));
      } else {
        throw error;
      }
    }
  }
}

// -------------------- WHATSAPP --------------------
async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({ auth: state, browser: ['Ubuntu', 'Chrome', '22.04.4'] });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("📲 Escanea este código QR:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== 401);
      console.log('❌ Conexión cerrada. Reintentando:', shouldReconnect);
      if (shouldReconnect) iniciarBot();
    } else if (connection === 'open') {
      console.log('✅ Conectado a WhatsApp correctamente.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const numero = m.key.remoteJid;
    const texto = m.message.conversation || '';

    if (!numerosAutorizados.includes(numero)) {
      console.log('🔒 Número no autorizado:', numero);
      return;
    }

    if (texto.startsWith('/')) {
      if (texto === '/ayuda') {
        await sock.sendMessage(numero, {
          text: `📋 *Comandos disponibles*:\n\n/resumen - Ver los últimos gastos\n/total - Ver el total de gastos acumulado\n/ayuda - Ver esta lista de comandos`
        });
        return;
      }
      if (texto === '/total') {
        const total = await calcularTotalGastos();
        await sock.sendMessage(numero, {
          text: `💰 *Total acumulado de gastos:* Q${total.toLocaleString('es-GT')}`
        });
        return;
      }
      if (texto === '/resumen') {
        const resumen = await obtenerResumenUltimosGastos();
        await sock.sendMessage(numero, { text: resumen });
        return;
      }
    }

    try {
      let datos = analizarTextoLocal(texto);
      if (!datos) {
        console.log('🤖 Usando GPT para interpretar el mensaje...');
        datos = await analizarTexto(texto);
      }
      await registrarGasto(datos.descripcion, datos.valor, datos.categoria);
      await sock.sendMessage(numero, { text: "✅ Gasto registrado con éxito 😊" });
    } catch (err) {
      console.error('❌ Error al registrar gasto:', err.message);
      await sock.sendMessage(numero, {
        text: "❌ No pude registrar el gasto. Intenta con el formato 'Comida 45000' o usa /ayuda",
      });
    }
  });
}

iniciarBot();

