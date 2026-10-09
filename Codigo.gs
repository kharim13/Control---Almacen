/**
 * CONTROL ALMACÉN · Google Sheets + Apps Script
 * Flujo por documentos, como en los ERP de obra:
 *   NI Nota de Ingreso · VS Vale de Salida · PR Préstamo · DV Devolución · AJ Ajuste por inventario
 *   LG Pase a stock general (saldo de un área/requerimiento que almacén libera para cualquier área)
 *   IM Internamiento (sobrante que devuelve un contratista) · MR Merma / chatarra (baja de stock)
 * Cada línea de ingreso es una "orden" (lote) con su ORC, REQ y área. Las salidas y préstamos
 * eligen de qué orden sale el material; las devoluciones regresan a su orden.
 * Hojas: MATERIALES, MOVIMIENTOS, ENTIDADES, USUARIOS (se registran) · STOCK y KARDEX (se calculan).
 */

const HOJAS = {
  MATERIALES: ['CODIGO', 'DESCRIPCION', 'CATEGORIA', 'UND', 'STOCK_MIN', 'UBICACION', 'VIDA_TIPO', 'VIDA_DIAS', 'VIDA_FUENTE', 'RETAZO_DE', 'KG_M'],
  MOVIMIENTOS: ['ID', 'DOC', 'TIPO', 'FECHA', 'CODIGO', 'DESCRIPCION', 'UND', 'CANT', 'PU', 'TOTAL',
                'PROVEEDOR', 'ORC', 'REQ', 'GUIA', 'CONTRATISTA', 'OBRA', 'USO', 'SOLICITANTE',
                'DOC_REF', 'FECHA_DEV', 'OBS', 'USUARIO', 'REGISTRADO', 'AREA', 'LOTE', 'LOTE_ORIGEN',
                'UND_COMPRA', 'CANT_COMPRA', 'PU_COMPRA', 'FACTOR', 'VENCE', 'ESTADO_DEV', 'ANULADO', 'CORREGIDO', 'ULT_MOV', 'CANT_OC', 'CONTRATO', 'AUTORIZA'],
  EQUIVALENCIAS: ['CODIGO', 'UND_COMPRA', 'FACTOR', 'TIPO', 'OBS'],
  SOLICITUDES: ['ID', 'DOC', 'NRO_AREA', 'FECHA', 'AREA', 'SOLICITANTE', 'RECEPTOR', 'RESPONSABLE', 'OBRA', 'MOTIVO', 'METRADO', 'LOTES_OBRA', 'MZ', 'USO',
                'CODIGO', 'DESCRIPCION', 'UND', 'CANT', 'LOTE', 'REQ', 'ATENDIDO', 'ESTADO', 'DOC_SAL', 'OBS', 'ORIGEN', 'USUARIO', 'REGISTRADO',
                'VISTA_POR', 'VISTA_EN', 'APROBADA_POR', 'APROBADA_EN', 'CERRADA_POR', 'CERRADA_EN',
                'RECOJO_FECHA', 'RECOJO_TURNO', 'RECOJO_LIMITE', 'RECOJO_HORA', 'CONTRATO', 'PRESTAMO', 'FECHA_DEV'],
  CORRECCIONES: ['FECHA', 'USUARIO', 'DOC', 'ID', 'CAMPO', 'ANTES', 'AHORA', 'MOTIVO'],
  UNIDADES: ['NOMBRE', 'CODIGO_SUNAT', 'SINONIMOS', 'ACTIVO'],
  ENTIDADES: ['TIPO', 'NOMBRE', 'DOCUMENTO', 'CONTACTO', 'ACTIVO'],
  USUARIOS: ['USUARIO', 'NOMBRE', 'ROL', 'CLAVE', 'ACTIVO', 'CREADO', 'AREA', 'CORREO'],
  STOCK: ['CODIGO', 'DESCRIPCION', 'CATEGORIA', 'UND', 'ENTRADAS', 'SALIDAS', 'PRESTADO', 'SALDO', 'STOCK_MIN', 'ESTADO', 'COSTO_PROM', 'VALOR S/'],
  KARDEX: ['CODIGO', 'DESCRIPCION', 'FECHA', 'DOC', 'TIPO', 'ENTRADA', 'SALIDA', 'SALDO', 'ORDEN (ORC)', 'AREA', 'CONTRATISTA / PROVEEDOR', 'OBRA', 'OBS']
};

const TEXTO = { MATERIALES: ['CODIGO', 'RETAZO_DE'], CORRECCIONES: ['DOC', 'ANTES', 'AHORA'], MOVIMIENTOS: ['DOC', 'ORC', 'REQ', 'GUIA', 'DOC_REF', 'LOTE', 'LOTE_ORIGEN', 'VENCE', 'ULT_MOV'], USUARIOS: ['USUARIO'], EQUIVALENCIAS: ['CODIGO'],
                SOLICITUDES: ['DOC', 'NRO_AREA', 'LOTE', 'REQ', 'DOC_SAL', 'MZ', 'LOTES_OBRA', 'REGISTRADO', 'VISTA_EN', 'APROBADA_EN', 'CERRADA_EN', 'RECOJO_FECHA', 'RECOJO_LIMITE', 'RECOJO_HORA'] };

/** Unidades que solo se cuentan en enteros (no se acepta 2.5 BOLSA). El resto (KG, M, GALON…) admite decimales. */
const ENTERAS = ['UND', 'UNID', 'UNIDAD', 'PZA', 'PIEZA', 'BOLSA', 'BLS', 'PLANCHA', 'VARILLA', 'CARTUCHO', 'CAJA', 'CAJAS', 'PAR', 'JGO', 'JUEGO'];
const entera_ = und => ENTERAS.indexOf(U_(und)) >= 0;

// Prefijo del documento y efecto en el stock (+1 entra, -1 sale; el ajuste guarda la diferencia con signo).
const TIPOS = {
  INGRESO:    { pre: 'NI', signo: 1 },
  SALIDA:     { pre: 'VS', signo: -1 },
  PRESTAMO:   { pre: 'PR', signo: -1 },
  DEVOLUCION: { pre: 'DV', signo: 1 },
  AJUSTE:     { pre: 'AJ', signo: 1 },
  LIBERACION: { pre: 'LG', signo: 0 },    // pase a stock general: no cambia el stock total, solo de quién es el saldo
  INTERNAMIENTO: { pre: 'IM', signo: 1 },  // sobrante que devuelve un contratista: entra a stock general (lo malogrado no entra)
  MERMA:      { pre: 'MR', signo: -1 }     // baja por merma, chatarra o material inservible
};

/** Un documento anulado se conserva en la hoja (con quién, cuándo y por qué) pero deja de contar. */
const vivo_ = m => !S_(m.ANULADO);

/**
 * Vida útil por material (referencial; la manda la ficha técnica del fabricante o la fecha impresa en el empaque).
 *   PERECIBLE: vence a los VIDA_DIAS del ingreso (o en la fecha VENCE escrita en el ingreso).
 *   REVISION: no vence, pero se revisa cada VIDA_DIAS (óxido, humedad).
 *   HERRAMIENTA: se gasta con el uso; VIDA_DIAS es la reposición referencial y al devolverla se anota su estado.
 */
const VIDA_TIPOS = ['PERECIBLE', 'REVISION', 'HERRAMIENTA'];
const DIAS_POR_VENCER = 15;     // aviso de vencimiento con esta anticipación
const DIAS_DORMIDO = 60;        // saldo de un área sin ninguna salida en estos días = material dormido
const ESTADOS_DEV = ['BUENO', 'REGULAR', 'MALOGRADO'];

const ROLES = { ADMIN: 'Administrador', ALMACEN: 'Almacenero', GERENCIA: 'Gerencia (consulta)', AREA: 'Área (consulta)' };
const ESCRIBEN = ['ADMIN', 'ALMACEN'];
const PIDEN = ['ADMIN', 'ALMACEN', 'AREA'];              // quiénes pueden crear una solicitud de material
/** Documentos que pueden llevar el contrato del contratista (texto libre y opcional, ej. CT-2026-014). */
const TIPOS_CONTRATO = ['SALIDA', 'PRESTAMO', 'DEVOLUCION', 'INTERNAMIENTO', 'MERMA'];
function contrato_(v) { return U_(v).replace(/\s+/g, ' ').slice(0, 40); }

const TIPOS_ENTIDAD = { PROVEEDOR: 'PROVEEDOR', CONTRATISTA: 'CONTRATISTA', AREA: 'AREA', OBRA: 'OBRA' };   // tipo → columna de MOVIMIENTOS

/* ---------------- Menú y aplicación web ---------------- */

function onOpen() {
  let ui;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { return autorizar(); }   // ejecutado desde el editor: no hay hoja abierta
  ui.createMenu('Almacén')
    .addItem('Abrir aplicación', 'abrirApp')
    .addItem('Recalcular STOCK y KARDEX', 'recalcular')
    .addItem('Dar permisos (correo, aviso y copia semanal)', 'autorizar')
    .addSeparator()
    .addItem('Preparar hojas (primera vez o tras actualizar)', 'prepararHojas')
    .addToUi();
}

/**
 * Ejecútala una vez desde el editor (Ejecutar → autorizar) para que Google pida todos los permisos:
 * hoja de cálculo, enviar correos y programar el aviso semanal.
 */
function autorizar() {
  SpreadsheetApp.getActive().getName();
  const cuota = MailApp.getRemainingDailyQuota();
  ScriptApp.getProjectTriggers();
  DriveApp.getRootFolder().getName();   // copia semanal de respaldo (Drive)
  const msg = 'Permisos listos. Correos disponibles hoy: ' + cuota + '. Ahora publica una nueva versión en Implementar → Gestionar implementaciones.';
  Logger.log(msg);
  return msg;
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Control Almacén')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function abrirApp() {
  const html = HtmlService.createHtmlOutputFromFile('Index').setWidth(1300).setHeight(800);
  SpreadsheetApp.getUi().showModelessDialog(html, 'Control Almacén');
}

/**
 * Crea las hojas que falten, agrega columnas nuevas al final, carga la lista maestra
 * con los nombres ya usados y crea el usuario ADMIN si no hay usuarios. No borra datos.
 */
function prepararHojas() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(HOJAS).forEach(nombre => {
    let sh = ss.getSheetByName(nombre);
    if (!sh) sh = ss.insertSheet(nombre);
    asegurarEncabezados_(sh, nombre);
    sh.getRange(1, 1, 1, HOJAS[nombre].length).setFontWeight('bold').setBackground('#1f3b57').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  });
  let msg = 'Hojas listas.';
  if (!leer_('ENTIDADES').length) {
    const mov = leer_('MOVIMIENTOS'), filas = [], visto = {};
    const add = (tipo, nombre) => { const n = U_(nombre), k = tipo + '|' + n; if (n && !visto[k]) { visto[k] = 1; filas.push({ TIPO: tipo, NOMBRE: n, ACTIVO: 'SI' }); } };
    ['RESIDENCIA', 'SANEAMIENTO', 'LOGISTICA'].forEach(a => add('AREA', a));
    mov.forEach(m => Object.keys(TIPOS_ENTIDAD).forEach(t => add(t, m[TIPOS_ENTIDAD[t]])));
    if (filas.length) agregarFilas_('ENTIDADES', filas);
    msg += ' Lista maestra cargada con ' + filas.length + ' nombres.';
  }
  if (!leer_('USUARIOS').length) {
    agregarFilas_('USUARIOS', [{ USUARIO: 'ADMIN', NOMBRE: 'ADMINISTRADOR', ROL: 'ADMIN', CLAVE: claveNueva_('almacen2026'), ACTIVO: 'SI', CREADO: new Date() }]);
    msg += ' Usuario creado: ADMIN, contraseña: almacen2026 (cámbiala al ingresar).';
  }
  recalcular();
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* sin interfaz */ }
  return msg;
}

/** Agrega al final las columnas que falten en la fila 1, sin mover las existentes. */
function asegurarEncabezados_(sh, nombre) {
  const head = HOJAS[nombre], n = Math.max(sh.getLastColumn(), 1);
  const act = sh.getRange(1, 1, 1, n).getValues()[0].map(h => String(h).trim()).filter(Boolean);
  if (!act.length || ['STOCK', 'KARDEX'].indexOf(nombre) >= 0) { sh.getRange(1, 1, 1, head.length).setValues([head]); return; }
  const faltan = head.filter(h => act.indexOf(h) < 0);
  if (faltan.length) sh.getRange(1, act.length + 1, 1, faltan.length).setValues([faltan]);
}

/* ---------------- Usuarios y sesión ---------------- */

function hash_(clave, sal) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, sal + '|' + clave, Utilities.Charset.UTF_8));
}
function claveNueva_(clave) {
  if (String(clave || '').length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres.');
  const sal = Utilities.getUuid().slice(0, 8);
  return sal + '$' + hash_(String(clave), sal);
}
function claveOk_(guardada, clave) {
  const p = String(guardada || '').split('$');
  return p.length === 2 && hash_(String(clave), p[0]) === p[1];
}

function login(usuario, clave) {
  const u = U_(usuario), cache = CacheService.getScriptCache(), kf = 'fail_' + u, fallos = N_(cache.get(kf));
  if (fallos >= 5) throw new Error('Demasiados intentos fallidos. Espera 10 minutos.');
  const r = leer_('USUARIOS').find(x => U_(x.USUARIO) === u && U_(x.ACTIVO) !== 'NO');
  if (!r || !claveOk_(r.CLAVE, clave)) { cache.put(kf, String(fallos + 1), 600); throw new Error('Usuario o contraseña incorrectos.'); }
  cache.remove(kf);
  const ses = { usuario: String(r.USUARIO), nombre: String(r.NOMBRE || r.USUARIO), rol: U_(r.ROL), area: U_(r.AREA), t: Date.now() };
  const token = Utilities.getUuid();
  cache.put('ses_' + token, JSON.stringify(ses), 21600);
  return Object.assign({ token: token, rolNombre: ROLES[ses.rol] || ses.rol }, ses);
}

function logout(token) { CacheService.getScriptCache().remove('ses_' + token); return true; }

/** Valida la sesión (y el rol si se indica). La sesión dura 6 horas desde el último uso. */
function auth_(token, roles) {
  const cache = CacheService.getScriptCache(), s = token ? cache.get('ses_' + token) : null;
  if (!s) throw new Error('SESION: Tu sesión terminó. Vuelve a ingresar.');
  const o = JSON.parse(s), rev = N_(cache.get('rev_' + U_(o.usuario)));
  if (rev && !(N_(o.t) > rev)) { cache.remove('ses_' + token); throw new Error('SESION: Tu usuario fue desactivado o eliminado.'); }
  if (roles && roles.indexOf(o.rol) < 0) throw new Error('Tu usuario (' + (ROLES[o.rol] || o.rol) + ') no tiene permiso para esta acción.');
  cache.put('ses_' + token, s, 21600);
  return o;
}

function cambiarClave(token, actual, nueva) {
  const ses = auth_(token);
  return conBloqueo_(() => {
    const sh = hoja_('USUARIOS'), v = sh.getDataRange().getValues(), h = v[0].map(String);
    const i = v.findIndex((r, k) => k > 0 && U_(r[h.indexOf('USUARIO')]) === U_(ses.usuario));
    if (i < 1 || !claveOk_(v[i][h.indexOf('CLAVE')], actual)) throw new Error('La contraseña actual no es correcta.');
    sh.getRange(i + 1, h.indexOf('CLAVE') + 1).setValue(claveNueva_(nueva));
    return true;
  });
}

/** Crea o modifica un usuario (solo administrador). d: {usuario, nombre, rol, clave?, activo} */
function guardarUsuario(token, d) {
  auth_(token, ['ADMIN']);
  return conBloqueo_(() => {
    const u = U_(d.usuario), rol = U_(d.rol);
    if (!/^[A-Z0-9._-]{3,30}$/.test(u)) throw new Error('El usuario debe tener de 3 a 30 letras o números, sin espacios.');
    if (!ROLES[rol]) throw new Error('Rol no válido.');
    const area = rol === 'AREA' ? entidad_(leer_('ENTIDADES'), 'AREA', d.area, true, 'áreas') : '';
    const correo = S_(d.correo);
    if (correo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) throw new Error('El correo no es válido.');
    const sh = hoja_('USUARIOS'); asegurarEncabezados_(sh, 'USUARIOS');
    const v = sh.getDataRange().getValues(), h = v[0].map(String);
    const col = n => h.indexOf(n) + 1;
    const i = v.findIndex((r, k) => k > 0 && U_(r[col('USUARIO') - 1]) === u);
    if (i < 1) {
      agregarFilas_('USUARIOS', [{ USUARIO: u, NOMBRE: U_(d.nombre) || u, ROL: rol, CLAVE: claveNueva_(d.clave), ACTIVO: 'SI', CREADO: new Date(), AREA: area, CORREO: correo }]);
    } else {
      const activo = d.activo === false ? 'NO' : 'SI';
      if (rol !== 'ADMIN' || activo === 'NO') {
        const otrosAdmin = v.filter((r, k) => k > 0 && k !== i && U_(r[col('ROL') - 1]) === 'ADMIN' && U_(r[col('ACTIVO') - 1]) !== 'NO').length;
        if (U_(v[i][col('ROL') - 1]) === 'ADMIN' && !otrosAdmin) throw new Error('Debe quedar al menos un administrador activo.');
      }
      sh.getRange(i + 1, col('NOMBRE')).setValue(U_(d.nombre) || u);
      sh.getRange(i + 1, col('ROL')).setValue(rol);
      sh.getRange(i + 1, col('AREA')).setValue(area);
      sh.getRange(i + 1, col('CORREO')).setValue(correo);
      sh.getRange(i + 1, col('ACTIVO')).setValue(activo);
      if (activo === 'NO') revocar_(u);
      if (d.clave) sh.getRange(i + 1, col('CLAVE')).setValue(claveNueva_(d.clave));
    }
    return u;
  });
}

/** Cierra al instante las sesiones abiertas de un usuario (desactivado o eliminado). */
function revocar_(usuario) { CacheService.getScriptCache().put('rev_' + U_(usuario), String(Date.now()), 21600); }

/** Elimina un usuario (solo administrador). Sus documentos conservan su nombre. */
function eliminarUsuario(token, usuario) {
  const ses = auth_(token, ['ADMIN']);
  return conBloqueo_(() => {
    const u = U_(usuario);
    if (u === U_(ses.usuario)) throw new Error('No puedes eliminar tu propio usuario.');
    const sh = hoja_('USUARIOS'), v = sh.getDataRange().getValues(), h = v[0].map(String), c = n => h.indexOf(n);
    const i = v.findIndex((r, k) => k > 0 && U_(r[c('USUARIO')]) === u);
    if (i < 1) throw new Error('No existe el usuario ' + u + '.');
    if (U_(v[i][c('ROL')]) === 'ADMIN' && U_(v[i][c('ACTIVO')]) !== 'NO' &&
        !v.some((r, k) => k > 0 && k !== i && U_(r[c('ROL')]) === 'ADMIN' && U_(r[c('ACTIVO')]) !== 'NO')) throw new Error('Debe quedar al menos un administrador activo.');
    sh.deleteRow(i + 1);
    revocar_(u);
    return u;
  });
}

/* ---------------- Lectura ---------------- */

function hoja_(nombre) {
  const sh = SpreadsheetApp.getActive().getSheetByName(nombre);
  if (!sh) throw new Error('Falta la hoja ' + nombre + '. Usa el menú Almacén → Preparar hojas.');
  return sh;
}

function leer_(nombre) {
  const v = hoja_(nombre).getDataRange().getValues();
  if (v.length < 2) return [];
  const head = v[0].map(h => String(h).trim());
  const tz = Session.getScriptTimeZone();
  return v.slice(1).filter(r => r.some(c => c !== '' && c !== null)).map(r => {
    const o = {};
    head.forEach((h, i) => {
      const c = r[i];
      if (h) o[h] = c instanceof Date ? Utilities.formatDate(c, tz, 'yyyy-MM-dd') : c;
    });
    return o;
  });
}

/** Hoja que se crea sola si falta (para no obligar a correr Preparar hojas otra vez). */
function hojaAuto_(nombre) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(nombre);
  if (!sh) { sh = ss.insertSheet(nombre); asegurarEncabezados_(sh, nombre); sh.getRange(1, 1, 1, HOJAS[nombre].length).setFontWeight('bold').setBackground('#1f3b57').setFontColor('#ffffff'); sh.setFrozenRows(1); }
  return sh;
}

/* ---------------- Prueba piloto ---------------- */

const PILOTO_HOJAS = { MATERIALES: x => U_(x.CODIGO), ENTIDADES: x => U_(x.TIPO) + '|' + U_(x.NOMBRE), USUARIOS: x => U_(x.USUARIO), EQUIVALENCIAS: x => U_(x.CODIGO) + '|' + U_(x.UND_COMPRA) };

function pilotoInfo_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('PILOTO') || 'null'); } catch (e) { return null; }
}

/** Marca el inicio de la prueba piloto: guarda qué materiales, contratistas, usuarios y equivalencias ya existían. */
function empezarPiloto(token) {
  const ses = auth_(token, ['ADMIN']);
  return conBloqueo_(() => {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName('_PILOTO'); if (!sh) sh = ss.insertSheet('_PILOTO');
    sh.clear(); sh.hideSheet();
    const filas = [['HOJA', 'CLAVE']];
    Object.keys(PILOTO_HOJAS).forEach(n => leer_(n).forEach(x => filas.push([n, PILOTO_HOJAS[n](x)])));
    sh.getRange(1, 1, filas.length, 2).setNumberFormat('@').setValues(filas);
    const info = { desde: hoy_(), por: ses.nombre };
    PropertiesService.getScriptProperties().setProperty('PILOTO', JSON.stringify(info));
    return info;
  });
}

/** Lo que se borraría al limpiar: conteos y lo creado durante la prueba piloto. */
function resumenLimpieza(token) {
  auth_(token, ['ADMIN']);
  const r = { piloto: pilotoInfo_(), movimientos: leer_('MOVIMIENTOS').length, docs: uniq_(leer_('MOVIMIENTOS').map(x => S_(x.DOC))).length,
              solicitudes: uniq_(solicitudes_().map(x => S_(x.DOC))).length, correcciones: leer_('CORRECCIONES').length, nuevos: {} };
  const sh = SpreadsheetApp.getActive().getSheetByName('_PILOTO');
  if (r.piloto && sh) {
    const antes = {}; sh.getDataRange().getValues().slice(1).forEach(f => antes[f[0] + '#' + U_(f[1])] = true);
    Object.keys(PILOTO_HOJAS).forEach(n => { r.nuevos[n] = leer_(n).filter(x => !antes[n + '#' + PILOTO_HOJAS[n](x)]).map(x => ({ clave: PILOTO_HOJAS[n](x),
      texto: n === 'MATERIALES' ? x.CODIGO + ' · ' + x.DESCRIPCION : n === 'ENTIDADES' ? x.NOMBRE + ' (' + U_(x.TIPO).toLowerCase() + ')' : n === 'USUARIOS' ? x.USUARIO + ' · ' + x.NOMBRE : x.CODIGO + ' · 1 ' + x.UND_COMPRA })); });
  }
  return r;
}

/**
 * Borra los datos de prueba (solo administrador): movimientos, solicitudes y correcciones, y reinicia la numeración.
 * Antes guarda una copia completa en Drive. borrar: {MATERIALES:[claves], ENTIDADES:[...], USUARIOS:[...], EQUIVALENCIAS:[...]} creados en la prueba.
 */
function limpiarDatosPrueba(token, confirma, borrar) {
  const ses = auth_(token, ['ADMIN']);
  if (U_(confirma) !== 'BORRAR') throw new Error('Escribe BORRAR para confirmar.');
  return conBloqueo_(() => {
    const ss = SpreadsheetApp.getActive();
    const copia = ss.copy(ss.getName() + ' - respaldo antes de limpiar ' + fechaTxt_(hoy_()));
    const r = { movimientos: leer_('MOVIMIENTOS').length, solicitudes: uniq_(solicitudes_().map(x => S_(x.DOC))).length, borrados: 0, url: copia.getUrl() };
    reescribir_('MOVIMIENTOS', []); reescribir_('SOLICITUDES', []); reescribir_('CORRECCIONES', []);
    borrar = borrar || {};
    const usr = (borrar.USUARIOS || []).map(U_).filter(u => u !== U_(ses.usuario));
    const quitar = { MATERIALES: (borrar.MATERIALES || []).map(U_), ENTIDADES: (borrar.ENTIDADES || []).map(U_), USUARIOS: usr, EQUIVALENCIAS: (borrar.EQUIVALENCIAS || []).map(U_) };
    quitar.MATERIALES.forEach(c => { leer_('EQUIVALENCIAS').forEach(e => { if (U_(e.CODIGO) === c) quitar.EQUIVALENCIAS.push(PILOTO_HOJAS.EQUIVALENCIAS(e)); }); });
    Object.keys(quitar).forEach(n => { if (!quitar[n].length) return;
      const sh = hoja_(n), v = sh.getDataRange().getValues(), h = v[0].map(String);
      const obj = row => { const o = {}; h.forEach((k, j) => o[k] = row[j]); return o; };
      for (let i = v.length - 1; i >= 1; i--) if (quitar[n].indexOf(PILOTO_HOJAS[n](obj(v[i]))) >= 0) { sh.deleteRow(i + 1); r.borrados++; }
    });
    usr.forEach(revocar_);
    const props = PropertiesService.getScriptProperties();
    props.getKeys().filter(k => /^NUM_/.test(k)).forEach(k => props.deleteProperty(k));
    props.deleteProperty('CIERRE_ULTIMO'); props.deleteProperty('PILOTO');
    const sp = ss.getSheetByName('_PILOTO'); if (sp) ss.deleteSheet(sp);
    recalcular();
    return r;
  });
}

function getData(token) {
  const ses = auth_(token);
  hojaAuto_('EQUIVALENCIAS');
  const d = { mat: leer_('MATERIALES'), mov: leer_('MOVIMIENTOS'), ent: leer_('ENTIDADES'), eq: leer_('EQUIVALENCIAS'), sesion: Object.assign({ rolNombre: ROLES[ses.rol] }, ses), roles: ROLES };
  const sol = solicitudes_();
  d.sol = ses.rol === 'AREA' ? sol.filter(x => U_(x.AREA) === U_(ses.area)) : sol;
  if (ses.rol === 'ADMIN') d.avisoSemanal = avisoSemanalActivo_();
  if (ses.rol === 'ADMIN') d.cierre = ultimoCierre_();
  d.piloto = pilotoInfo_();
  d.url = urlApp_();
  d.und = unidades_();   // los códigos QR abren la app en este enlace
  if (ses.rol === 'ADMIN') d.respaldo = respaldoInfo_();
  if (ses.rol === 'ADMIN') d.usuarios = leer_('USUARIOS').map(u => ({ USUARIO: u.USUARIO, NOMBRE: u.NOMBRE, ROL: u.ROL, ACTIVO: u.ACTIVO, CREADO: u.CREADO, AREA: u.AREA || '', CORREO: u.CORREO || '' }));
  return d;
}

/* ---------------- Cálculos ---------------- */

const U_ = v => String(v == null ? '' : v).trim().toUpperCase();
const N_ = v => Number(v) || 0;
const S_ = v => String(v == null ? '' : v).trim();

function efecto_(m) {
  const t = TIPOS[U_(m.TIPO)];
  if (!t || !vivo_(m)) return 0;
  if (U_(m.TIPO) === 'INTERNAMIENTO' && U_(m.ESTADO_DEV) === 'MALOGRADO') return 0;  // se registra como merma, no entra al stock
  if (U_(m.TIPO) === 'DEVOLUCION' && S_(m.LOTE_ORIGEN)) return 0;   // reposición entre órdenes: no cambia el stock total
  return t.signo * N_(m.CANT);
}

function ordenar_(movs) {
  return movs.slice().sort((a, b) => String(a.FECHA).localeCompare(String(b.FECHA)) || N_(a.ID) - N_(b.ID));
}

/** Saldo, costo promedio y préstamos por material. */
function calcularStock_(mat, mov) {
  const r = {};
  mov = mov.filter(vivo_);
  mat.forEach(m => r[U_(m.CODIGO)] = { m, ent: 0, sal: 0, pres: 0, saldo: 0, qIng: 0, vIng: 0 });
  mov.forEach(x => {
    const k = U_(x.CODIGO); if (!r[k]) return;
    const e = efecto_(x), t = U_(x.TIPO), s = r[k];
    s.saldo += e;
    if (e > 0) s.ent += e; else s.sal -= e;
    if (t === 'INGRESO') { s.qIng += N_(x.CANT); s.vIng += N_(x.CANT) * N_(x.PU); }
  });
  pendientesPrestamo_(mov).forEach(p => { const s = r[U_(p.CODIGO)]; if (s) s.pres += p.pendiente; });
  return Object.values(r).map(s => {
    const min = N_(s.m.STOCK_MIN), cp = s.qIng ? s.vIng / s.qIng : 0;
    const estado = (!s.ent && !s.sal && !min) ? 'Sin movimiento'
                 : s.saldo <= 0 ? 'Sin stock' : (min > 0 && s.saldo <= min ? 'Bajo mínimo' : 'Normal');
    return { CODIGO: s.m.CODIGO, DESCRIPCION: s.m.DESCRIPCION, CATEGORIA: s.m.CATEGORIA, UND: s.m.UND,
             ENTRADAS: s.ent, SALIDAS: s.sal, PRESTADO: s.pres, SALDO: s.saldo, STOCK_MIN: min, ESTADO: estado,
             COSTO_PROM: Math.round(cp * 10000) / 10000, VALOR: Math.round(Math.max(0, s.saldo) * cp * 100) / 100 };
  });
}

/** Préstamos con cantidad aún no devuelta: una fila por documento PR, material y orden. */
function pendientesPrestamo_(mov) {
  const p = {}, key = (d, x) => U_(d) + '|' + U_(x.CODIGO) + '|' + S_(x.LOTE);
  mov = mov.filter(vivo_);
  mov.forEach(x => {
    if (U_(x.TIPO) !== 'PRESTAMO') return;
    const k = key(x.DOC, x);
    const o = p[k] || (p[k] = { DOC: x.DOC, CODIGO: x.CODIGO, DESCRIPCION: x.DESCRIPCION, UND: x.UND, CONTRATISTA: x.CONTRATISTA, AREA: x.AREA, LOTE: S_(x.LOTE),
                                OBRA: x.OBRA, SOLICITANTE: x.SOLICITANTE, FECHA: x.FECHA, FECHA_DEV: x.FECHA_DEV, prestado: 0, devuelto: 0 });
    o.prestado += N_(x.CANT);
  });
  mov.forEach(x => {
    if (U_(x.TIPO) === 'DEVOLUCION' && x.DOC_REF) { const o = p[key(x.DOC_REF, x)]; if (o) o.devuelto += N_(x.CANT); }
  });
  return Object.values(p).map(o => Object.assign(o, { pendiente: o.prestado - o.devuelto })).filter(o => o.pendiente > 0);
}

/**
 * Saldo por orden (lote = línea de ingreso). Los movimientos con LOTE afectan a esa orden;
 * los antiguos sin orden asignada salen de la más antigua con saldo (PEPS) y las entradas van a la más reciente.
 */
function lotes_(mov) {
  const L = {}, porMat = {};
  ordenar_(mov.filter(vivo_)).forEach(x => {
    const t = U_(x.TIPO), k = U_(x.CODIGO), q = N_(x.CANT);
    if (t === 'INTERNAMIENTO') {
      // el sobrante bueno o regular es una orden nueva de stock general, valorizada a costo promedio
      if (efecto_(x) <= 0) return;
      const l = { ID: S_(x.LOTE) || S_(x.ID), DOC: x.DOC, CODIGO: x.CODIGO, DESCRIPCION: x.DESCRIPCION, UND: x.UND, ORC: '', REQ: 'STOCK', AREA: '',
                  PROVEEDOR: x.CONTRATISTA, FECHA: x.FECHA, PU: N_(x.PU), ING: q, SALDO: q, VENCE: '', ULT: x.FECHA, IM: true };
      L[l.ID] = l; (porMat[k] = porMat[k] || []).push(l);
      return;
    }
    if (t === 'INGRESO') {
      const l = { ID: S_(x.LOTE) || S_(x.ID), DOC: x.DOC, CODIGO: x.CODIGO, DESCRIPCION: x.DESCRIPCION, UND: x.UND, ORC: S_(x.ORC), REQ: S_(x.REQ),
                  AREA: U_(x.AREA), OBRA: U_(x.OBRA), PROVEEDOR: x.PROVEEDOR, FECHA: x.FECHA, PU: N_(x.PU), ING: q, SALDO: q, VENCE: S_(x.VENCE),
                  ULT: S_(x.ULT_MOV) > S_(x.FECHA) ? S_(x.ULT_MOV) : x.FECHA };   // ULT_MOV: último movimiento de la orden antes del cierre anual
      L[l.ID] = l; (porMat[k] = porMat[k] || []).push(l);
      return;
    }
    const lote = L[S_(x.LOTE)], org = L[S_(x.LOTE_ORIGEN)];
    if (lote && String(x.FECHA) > String(lote.ULT)) lote.ULT = x.FECHA;
    if (t === 'LIBERACION') {
      // el saldo sale de la orden del área y nace un lote de stock general con la misma ORC, precio y fecha de ingreso
      if (!lote) return;
      lote.SALDO -= q;
      const g = Object.assign({}, lote, { ID: S_(x.ID), DOC: x.DOC, REQ: 'STOCK', AREA: '', OBRA: '', ING: q, SALDO: q, ULT: x.FECHA,
                                          EX_REQ: lote.REQ, EX_AREA: lote.AREA, EX_LOTE: lote.ID });
      L[g.ID] = g; (porMat[k] = porMat[k] || []).push(g);
      return;
    }
    if (t === 'DEVOLUCION' && org) { if (lote) lote.SALDO += q; org.SALDO -= q; return; }
    if (t === 'AJUSTE' && !lote) {
      // conteo físico: el sobrante entra a stock general; el faltante sale primero del stock general y luego de las órdenes más antiguas
      const e = efecto_(x), ls = porMat[k] = porMat[k] || [];
      if (e > 0) {
        const g = { ID: S_(x.ID), DOC: x.DOC, CODIGO: x.CODIGO, DESCRIPCION: x.DESCRIPCION, UND: x.UND, ORC: '', REQ: 'STOCK', AREA: '',
                    PROVEEDOR: '', FECHA: x.FECHA, PU: N_(x.PU), ING: e, SALDO: e, VENCE: '', ULT: x.FECHA, AJ: true };
        L[g.ID] = g; ls.push(g); return;
      }
      repartoAjuste_(ls, -e).forEach(p => { p.l.SALDO -= p.q; });
      return;
    }
    const e = efecto_(x);
    if (lote) { lote.SALDO += e; return; }
    const ls = porMat[k] || []; if (!ls.length) return;
    if (e > 0) { ls[ls.length - 1].SALDO += e; return; }
    let r = -e;
    ls.forEach(l => { const u = Math.min(Math.max(l.SALDO, 0), r); l.SALDO -= u; r -= u; });
    if (r > 0) ls[ls.length - 1].SALDO -= r;
  });
  return L;
}

/** Reparte un faltante de inventario: primero el stock general, luego las órdenes de área de la más antigua a la más nueva. */
function repartoAjuste_(ls, r) {
  const gen = l => U_(l.REQ) === 'STOCK' || !S_(l.AREA), out = [];
  ls.filter(gen).concat(ls.filter(l => !gen(l))).forEach(l => {
    const u = Math.min(Math.max(l.SALDO, 0), r);
    if (u > 1e-9) { out.push({ l: l, q: u }); r -= u; }
  });
  if (r > 1e-9 && ls.length) out.push({ l: ls[ls.length - 1], q: r });
  return out;
}

/** Avisa a cada área cuando un faltante de inventario le bajó el saldo de una orden. */
function avisarAjuste_(doc, antes, motivo) {
  const L2 = lotes_(leer_('MOVIMIENTOS')), porArea = {};
  Object.keys(antes).forEach(id => { const a = antes[id], b = L2[id];
    if (!b || !a.AREA || U_(a.REQ) === 'STOCK') return;
    const d = Math.round((a.SALDO - b.SALDO) * 1e6) / 1e6;
    if (d > 0) (porArea[U_(a.AREA)] = porArea[U_(a.AREA)] || []).push('  • ' + a.DESCRIPCION + ': ' + d + ' ' + a.UND + ' (ORC ' + (a.ORC || 's/n') + (a.REQ ? ', ' + a.REQ : '') + ')'); });
  Object.keys(porArea).forEach(ar => enviarCorreo_(correos_(u => U_(u.ROL) === 'AREA' && U_(u.AREA) === ar),
    'Inventario físico: faltante en órdenes de ' + ar + ' · ' + doc,
    'En el inventario físico faltó material y el stock general no alcanzó para cubrirlo, así que se descontó de órdenes de tu área.\n\nDocumento: ' + doc +
    '\nMotivo: ' + motivo + '\n\n' + porArea[ar].join('\n') + '\n\nSi tienes dudas, coordina con almacén.'));
}

/** Reescribe las hojas STOCK y KARDEX. */
function recalcular() {
  const mat = leer_('MATERIALES'), mov = ordenar_(leer_('MOVIMIENTOS').filter(vivo_)), L = lotes_(mov);
  const st = calcularStock_(mat, mov).sort((a, b) => String(a.DESCRIPCION).localeCompare(String(b.DESCRIPCION)));
  escribir_('STOCK', st.map(s => [s.CODIGO, s.DESCRIPCION, s.CATEGORIA, s.UND, s.ENTRADAS, s.SALIDAS, s.PRESTADO, s.SALDO, s.STOCK_MIN, s.ESTADO, s.COSTO_PROM, s.VALOR]));
  const saldo = {}, kx = [];
  mov.forEach(x => {
    const k = U_(x.CODIGO), e = efecto_(x), l = L[S_(x.LOTE)] || {};
    saldo[k] = (saldo[k] || 0) + e;
    const obs = S_(x.LOTE_ORIGEN) ? 'Repone ' + x.CANT + ' a ORC ' + (l.ORC || '') + ' desde ORC ' + ((L[S_(x.LOTE_ORIGEN)] || {}).ORC || '')
              : U_(x.TIPO) === 'LIBERACION' ? 'Pasa ' + x.CANT + ' ' + x.UND + ' a stock general desde ORC ' + (l.ORC || '') + (x.AREA ? ' (' + x.AREA + ')' : '') + (x.OBS ? ': ' + x.OBS : '')
              : U_(x.TIPO) === 'INTERNAMIENTO' ? 'Internamiento de ' + (x.CONTRATISTA || '') + ' (' + (U_(x.ESTADO_DEV) || 'BUENO') + ')' + (U_(x.ESTADO_DEV) === 'MALOGRADO' ? ': no entra al stock, va a merma' : '') + (x.OBS ? ': ' + x.OBS : '')
              : U_(x.TIPO) === 'MERMA' ? 'Merma' + (x.CONTRATISTA ? ' de ' + x.CONTRATISTA : '') + ': ' + (x.OBS || '')
              : (x.OBS || '');
    kx.push([x.CODIGO, x.DESCRIPCION, x.FECHA, x.DOC, x.TIPO, e > 0 ? e : '', e < 0 ? -e : '', saldo[k],
             U_(x.TIPO) === 'INGRESO' ? x.ORC : (l.ORC || ''), x.AREA || '', x.CONTRATISTA || x.PROVEEDOR || '', x.OBRA || '', obs]);
  });
  kx.sort((a, b) => String(a[1]).localeCompare(String(b[1])));   // orden estable: por material y luego cronológico
  escribir_('KARDEX', kx);
}

function escribir_(nombre, filas) {
  const sh = hoja_(nombre), n = HOJAS[nombre].length;
  sh.getRange(1, 1, 1, n).setValues([HOJAS[nombre]]);
  const ult = sh.getLastRow(), anchas = Math.max(n, sh.getLastColumn());
  if (ult > 1) sh.getRange(2, 1, ult - 1, anchas).clearContent();
  if (filas.length) sh.getRange(2, 1, filas.length, n).setValues(filas);
}

/* ---------------- Escritura ---------------- */

function conBloqueo_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Agrega filas respetando el orden real de las columnas en la hoja. */
function agregarFilas_(nombre, objetos) {
  const sh = hoja_(nombre);
  asegurarEncabezados_(sh, nombre);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const filas = objetos.map(o => head.map(h => o[h] === undefined ? '' : o[h]));
  const colA = sh.getRange('A:A').getValues();
  let ultima = colA.length;
  while (ultima > 0 && (colA[ultima - 1][0] === '' || colA[ultima - 1][0] === null)) ultima--;
  // Columnas de texto: conserva ceros a la izquierda (ej. ORC 001-0003656, REQ 0025)
  (TEXTO[nombre] || []).forEach(h => { const c = head.indexOf(h); if (c >= 0) sh.getRange(ultima + 1, c + 1, filas.length, 1).setNumberFormat('@'); });
  sh.getRange(ultima + 1, 1, filas.length, head.length).setValues(filas);
}

function fecha_(txt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(txt || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
}

function siguienteDoc_(mov, pre) {
  const max = mov.filter(m => String(m.DOC).indexOf(pre + '-') === 0)
                 .reduce((a, m) => Math.max(a, parseInt(String(m.DOC).slice(pre.length + 1), 10) || 0), numBase_(pre));
  return pre + '-' + ('0000' + (max + 1)).slice(-4);
}

/** Verifica que el nombre exista en la lista maestra (activo). Devuelve el nombre tal como está registrado. */
function entidad_(ent, tipo, nombre, obligatorio, etiqueta) {
  const n = U_(nombre);
  if (!n) { if (obligatorio) throw new Error('Falta elegir un nombre de la lista de ' + etiqueta + '.'); return ''; }
  const e = ent.find(x => U_(x.TIPO) === tipo && U_(x.NOMBRE) === n && U_(x.ACTIVO) !== 'NO');
  if (!e) throw new Error(n + ' no está en la lista de ' + etiqueta + '. Regístralo primero con "+ Nuevo".');
  return U_(e.NOMBRE);
}

/**
 * Registra un documento con uno o varios ítems.
 * cab: {tipo, fecha, proveedor, orc, req, guia, area, contratista, obra, uso, solicitante, docRef, fechaDev, obs}
 * items: [{codigo, cant, pu, lote, origen}]
 *   lote: orden (ID de la línea de ingreso) de la que sale o a la que vuelve el material.
 *   origen: en una devolución, orden desde la que se repone (préstamo entre áreas ya consumido).
 *   En AJUSTE, cant es el conteo físico.
 */
function registrarDocumento(token, cab, items) {
  const ses = auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const doc = crearDocumento_(ses, cab, items);
    recalcular();
    avisarIngreso_(cab, items, doc);
    avisarPendientes_(cab, items, doc);
    return doc;
  });
}

/** Escribe el documento en MOVIMIENTOS. Sin candado ni recálculo: lo hace quien lo llama. */
function crearDocumento_(ses, cab, items) {
  {
    const tipo = U_(cab.tipo), T = TIPOS[tipo];
    if (!T || tipo === 'LIBERACION') throw new Error('Tipo de documento no válido.');
    if (!items || !items.length) throw new Error('El documento no tiene ítems.');
    if (tipo === 'PRESTAMO' && !cab.fechaDev) throw new Error('Indica la fecha en que deben devolverlo.');
    if (tipo === 'AJUSTE' && !S_(cab.obs)) throw new Error('Indica el motivo del ajuste.');
    if (tipo === 'MERMA' && !S_(cab.obs)) throw new Error('Indica el motivo de la merma (ej. retazos inservibles, chatarra para venta).');

    const ent = leer_('ENTIDADES');
    const proveedor = entidad_(ent, 'PROVEEDOR', cab.proveedor, tipo === 'INGRESO', 'proveedores');
    const contratista = entidad_(ent, 'CONTRATISTA', cab.contratista, tipo === 'SALIDA' || tipo === 'PRESTAMO' || tipo === 'INTERNAMIENTO', 'contratistas / receptores');
    const area = entidad_(ent, 'AREA', cab.area, ['INGRESO', 'SALIDA', 'PRESTAMO'].indexOf(tipo) >= 0, 'áreas');
    const obra = entidad_(ent, 'OBRA', cab.obra, false, 'obras');
    // contrato del contratista (opcional, nunca frena la salida): separa en el reporte lo usado por cada contrato
    let contrato = TIPOS_CONTRATO.indexOf(tipo) >= 0 ? contrato_(cab.contrato) : '';

    const mat = leer_('MATERIALES'), mov = leer_('MOVIMIENTOS');
    const porCod = {}; mat.forEach(m => porCod[U_(m.CODIGO)] = m);
    // un retazo (fierro cortado, tubo, cable…) se guarda como material aparte, medido en metros o piezas
    if (tipo === 'INTERNAMIENTO') items.forEach(it => { if (it.retazo) it.codigo = retazoDe_(mat, porCod, it.codigo, it.undRetazo).CODIGO; });
    const stock = {}; calcularStock_(mat, mov).forEach(s => stock[U_(s.CODIGO)] = s);
    const L = lotes_(mov);
    const tieneLotes = {}; Object.values(L).forEach(l => tieneLotes[U_(l.CODIGO)] = true);
    const pend = {}; pendientesPrestamo_(mov).forEach(p => pend[U_(p.DOC) + '|' + U_(p.CODIGO) + '|' + S_(p.LOTE)] = p);
    const conPR = tipo === 'DEVOLUCION' && U_(cab.docRef).indexOf('PR-') === 0;
    if (conPR && !contrato) { const pr = mov.find(x => U_(x.DOC) === U_(cab.docRef)); contrato = pr ? contrato_(pr.CONTRATO) : ''; }   // la devolución hereda el contrato del préstamo

    // Validar todos los ítems antes de escribir nada
    const porMat = {}, porLote = {}, porPend = {};
    const eq = tipo === 'INGRESO' ? (hojaAuto_('EQUIVALENCIAS'), leer_('EQUIVALENCIAS')) : [];
    items.forEach(it => {
      const k = U_(it.codigo), m = porCod[k], lote = S_(it.lote), origen = S_(it.origen);
      if (!m) throw new Error('El material ' + it.codigo + ' no existe en MATERIALES.');
      convertir_(tipo, it, m, eq);
      const q = it._q;
      if (tipo === 'AJUSTE' ? !(q >= 0) : !(q > 0)) throw new Error('Cantidad no válida para ' + m.DESCRIPCION + '.');
      if (entera_(m.UND) && Math.abs(q - Math.round(q)) > 1e-9)
        throw new Error(m.DESCRIPCION + ' se cuenta en ' + U_(m.UND) + ' enteras' + (it._c ? ': ' + it._c.cant + ' ' + it._c.und + ' dan ' + q + ' ' + U_(m.UND) + '. Revisa el factor.' : '. No se aceptan decimales.'));
      if (lote && (!L[lote] || U_(L[lote].CODIGO) !== k)) throw new Error('La orden elegida no corresponde a ' + m.DESCRIPCION + '.');
      if ((tipo === 'SALIDA' || tipo === 'PRESTAMO' || tipo === 'MERMA') && tieneLotes[k] && !lote) throw new Error('Elige de qué orden sale ' + m.DESCRIPCION + '.');
      if (origen) {
        if (!conPR) throw new Error('Solo una devolución de préstamo puede reponerse desde otra orden.');
        if (!L[origen] || U_(L[origen].CODIGO) !== k || origen === lote) throw new Error('La orden de reposición no es válida para ' + m.DESCRIPCION + '.');
        porLote[origen] = (porLote[origen] || 0) + q;
      } else {
        if (T.signo < 0) porMat[k] = (porMat[k] || 0) + q;
        if (T.signo < 0 && lote) porLote[lote] = (porLote[lote] || 0) + q;
      }
      if (conPR) { const pk = U_(cab.docRef) + '|' + k + '|' + lote; if (!pend[pk]) throw new Error(m.DESCRIPCION + ' no figura como pendiente en el préstamo ' + cab.docRef + '.');
                   porPend[pk] = (porPend[pk] || 0) + q; }
    });
    Object.keys(porMat).forEach(k => { const s = stock[k];
      if (porMat[k] > s.SALDO) throw new Error('Stock insuficiente de ' + s.DESCRIPCION + '. Disponible: ' + s.SALDO + ' ' + s.UND + '.'); });
    Object.keys(porLote).forEach(id => { const l = L[id];
      if (porLote[id] > l.SALDO) throw new Error('La orden ' + (l.ORC || l.DOC) + ' de ' + l.DESCRIPCION + ' solo tiene ' + l.SALDO + ' ' + l.UND + '.'); });
    Object.keys(porPend).forEach(pk => { const p = pend[pk];
      if (porPend[pk] > p.pendiente) throw new Error('Se devuelve más de lo prestado en ' + p.DESCRIPCION + '. Pendiente: ' + p.pendiente + '.'); });

    const doc = siguienteDoc_(mov, T.pre);
    let id = mov.reduce((a, m) => Math.max(a, N_(m.ID)), 0);
    const f = fecha_(cab.fecha), ahora = new Date();
    const filas = items.map(it => {
      const k = U_(it.codigo), m = porCod[k], s = stock[k];
      let cant = it._q;
      if (tipo === 'AJUSTE') cant = cant - s.SALDO;               // se guarda la diferencia
      const lote = L[S_(it.lote)], c = it._c;
      const pu = tipo === 'INGRESO' ? (c ? c.pu / c.factor : N_(it.pu)) : S_(m.RETAZO_DE) ? 0 : (lote ? lote.PU : s.COSTO_PROM);
      const est = tipo === 'INTERNAMIENTO' ? (ESTADOS_DEV.indexOf(U_(it.estado)) >= 0 ? U_(it.estado) : 'BUENO') : '';
      const total = c ? c.cant * c.pu : Math.abs(cant) * pu;
      const nid = ++id;
      return {
        ID: nid, DOC: doc, TIPO: tipo, FECHA: f, CODIGO: m.CODIGO, DESCRIPCION: m.DESCRIPCION, UND: m.UND,
        CANT: cant, PU: Math.round(pu * 1e6) / 1e6, TOTAL: Math.round(total * 100) / 100,
        UND_COMPRA: c ? c.und : '', CANT_COMPRA: c ? c.cant : '', PU_COMPRA: c ? c.pu : '', FACTOR: c ? c.factor : '',
        PROVEEDOR: proveedor, ORC: tipo === 'INGRESO' ? S_(cab.orc) : (lote ? S_(lote.ORC) : S_(cab.orc)),
        REQ: tipo === 'INGRESO' ? U_(cab.req) : (lote ? U_(lote.REQ) : U_(cab.req)), GUIA: U_(cab.guia),
        CONTRATISTA: contratista, OBRA: obra, CONTRATO: contrato, USO: U_(cab.uso), SOLICITANTE: U_(cab.solicitante),
        AUTORIZA: tipo === 'PRESTAMO' ? U_(cab.autoriza) : '',   // con autorización = préstamo entre obras / etapas
        DOC_REF: conPR ? U_(cab.docRef) : '', FECHA_DEV: tipo === 'PRESTAMO' ? fecha_(cab.fechaDev) : '', OBS: S_(cab.obs),
        USUARIO: ses.usuario, REGISTRADO: ahora, AREA: area,
        LOTE: tipo === 'INGRESO' || (tipo === 'INTERNAMIENTO' && est !== 'MALOGRADO') ? String(nid) : S_(it.lote), LOTE_ORIGEN: S_(it.origen),
        VENCE: tipo === 'INGRESO' && /^\d{4}-\d{2}-\d{2}$/.test(S_(it.vence)) ? S_(it.vence) : '',
        CANT_OC: tipo === 'INGRESO' && N_(it.cantOc) > 0 ? N_(it.cantOc) : '',   // total comprado en la ORC (para saber cuánto falta llegar)
        ESTADO_DEV: tipo === 'INTERNAMIENTO' ? est : tipo === 'DEVOLUCION' && ESTADOS_DEV.indexOf(U_(it.estado)) >= 0 ? U_(it.estado) : ''
      };
    });
    agregarFilas_('MOVIMIENTOS', filas);
    if (tipo === 'INGRESO') items.filter(it => it._c).forEach(it => recordarEquivalencia_(eq, it));
    if (tipo === 'AJUSTE') avisarAjuste_(doc, L, S_(cab.obs));
    return doc;
  }
}

/* ---------------- Préstamo entre obras / etapas ---------------- */

/**
 * Material para otra obra o etapa (ej. la II ETAPA usa saldo de la III ETAPA).
 * cab = {fecha, obra (la que pide), area, contratista (quién recibe), autoriza, obs (motivo), fechaDev}
 * items = [{codigo, cant, lote}]. Lo que sale de stock general no es de nadie: va en un vale de salida normal, sin deuda.
 * Lo que sale de una orden de otra etapa va en un préstamo (PR) que se devuelve a esa orden.
 * Devuelve {vs, pr}: los documentos creados (uno puede quedar vacío).
 */
function registrarPrestamoObras(token, cab, items) {
  const ses = auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const obra = U_(cab.obra);
    if (!obra) throw new Error('Elige la obra o etapa que pide el material.');
    if (!U_(cab.autoriza)) throw new Error('Escribe quién autorizó el préstamo.');
    if (!S_(cab.obs)) throw new Error('Escribe el motivo.');
    if (!items || !items.length) throw new Error('El documento no tiene ítems.');
    const L = lotes_(leer_('MOVIMIENTOS')), gen = [], pre = [];
    items.forEach(it => {
      const l = L[S_(it.lote)];
      if (!l || (!U_(l.AREA) && (!S_(l.REQ) || U_(l.REQ) === 'STOCK'))) { gen.push(it); return; }
      if (U_(l.OBRA) === obra) throw new Error('La orden ' + (l.ORC || l.DOC) + ' de ' + l.DESCRIPCION + ' ya es de ' + obra + ': no es préstamo, usa un vale de salida.');
      pre.push(it);
    });
    const r = { vs: '', pr: '' };
    if (pre.length) r.pr = crearDocumento_(ses, Object.assign({}, cab, { tipo: 'PRESTAMO', obra: obra }), pre);
    if (gen.length) r.vs = crearDocumento_(ses, Object.assign({}, cab, { tipo: 'SALIDA', obra: obra, autoriza: '',
      obs: S_(cab.obs) + ' · para ' + obra + ' (stock general, sin devolución)' + (r.pr ? ' · junto con ' + r.pr : '') }), gen);
    recalcular();
    return r;
  });
}

/* ---------------- Unidades de compra y equivalencias ---------------- */

/**
 * Pasa una línea de ingreso de la unidad de compra (ROLLO, CAJA, TONELADA…) a la unidad de almacén del material.
 * Deja en it._q la cantidad en unidad de almacén y en it._c lo comprado tal cual (und, cant, pu, factor).
 * Si la equivalencia es FIJA manda la lista; si es VARIABLE vale el factor escrito en el ingreso (peso real de la guía).
 */
function convertir_(tipo, it, m, eq) {
  const und = it.undCompra ? canonUnd_(it.undCompra) : '', base = U_(m.UND);
  it._c = null;
  it._q = Number(it.cant);
  if (tipo !== 'INGRESO' || !und) return;
  if (und === base || und === canonUnd_(base)) { if (!(it._q > 0) && Number(it.cantCompra) > 0) it._q = Number(it.cantCompra); return; }   // GL en un material en GALON: es la misma unidad
  const fila = eq.find(e => U_(e.CODIGO) === U_(m.CODIGO) && U_(e.UND_COMPRA) === und);
  const factor = fila && U_(fila.TIPO) === 'FIJA' ? N_(fila.FACTOR) : Number(it.factor);
  if (!(factor > 0)) throw new Error('Indica cuántos ' + base + ' trae 1 ' + und + ' de ' + m.DESCRIPCION + '.');
  const cant = Number(it.cantCompra), pu = N_(it.puCompra);
  if (!(cant > 0)) throw new Error('Cantidad no válida para ' + m.DESCRIPCION + '.');
  if (pu < 0) throw new Error('Precio no válido para ' + m.DESCRIPCION + '.');
  it._c = { und: und, cant: cant, pu: pu, factor: factor, fija: !!it.fija };
  it._q = Math.round(cant * factor * 1e6) / 1e6;
}

/** Guarda en EQUIVALENCIAS la unidad usada en un ingreso: nueva → se agrega; variable → queda el último factor. */
function recordarEquivalencia_(eq, it) {
  const c = it._c, cod = U_(it.codigo);
  const i = eq.findIndex(e => U_(e.CODIGO) === cod && U_(e.UND_COMPRA) === c.und);
  if (i < 0) {
    const fila = { CODIGO: cod, UND_COMPRA: c.und, FACTOR: c.factor, TIPO: c.fija ? 'FIJA' : 'VARIABLE', OBS: '' };
    agregarFilas_('EQUIVALENCIAS', [fila]); eq.push(fila);
  } else if (U_(eq[i].TIPO) !== 'FIJA' && N_(eq[i].FACTOR) !== c.factor) {
    escribirEquivalencia_(cod, c.und, { FACTOR: c.factor }); eq[i].FACTOR = c.factor;
  }
}

function escribirEquivalencia_(cod, und, cambios) {
  const sh = hojaAuto_('EQUIVALENCIAS'), v = sh.getDataRange().getValues(), head = v[0].map(h => String(h).trim());
  const iC = head.indexOf('CODIGO'), iU = head.indexOf('UND_COMPRA');
  const r = v.findIndex((f, i) => i > 0 && U_(f[iC]) === cod && U_(f[iU]) === und);
  if (r < 1) return false;
  Object.keys(cambios).forEach(h => { const j = head.indexOf(h); if (j >= 0) sh.getRange(r + 1, j + 1).setValue(cambios[h]); });
  return true;
}

/** Crea o corrige una equivalencia (solo administrador). d = {codigo, und, factor, tipo, obs} */
function guardarEquivalencia(token, d) {
  auth_(token, ['ADMIN']);
  return conBloqueo_(() => {
    const cod = U_(d.codigo), und = canonUnd_(d.und), factor = Number(d.factor), tipo = U_(d.tipo) === 'FIJA' ? 'FIJA' : 'VARIABLE';
    const m = leer_('MATERIALES').find(x => U_(x.CODIGO) === cod);
    if (!m) throw new Error('El material ' + d.codigo + ' no existe.');
    if (!und) throw new Error('Escribe la unidad de compra.');
    if (und === U_(m.UND) || und === canonUnd_(m.UND)) throw new Error(und + ' ya es la unidad de almacén de este material' + (U_(d.und) !== und ? ' (' + U_(d.und) + ' = ' + und + ')' : '') + '.');
    if (!(factor > 0)) throw new Error('El factor debe ser mayor que cero.');
    hojaAuto_('EQUIVALENCIAS');
    const cambios = { FACTOR: factor, TIPO: tipo, OBS: S_(d.obs) };
    if (!escribirEquivalencia_(cod, und, cambios)) agregarFilas_('EQUIVALENCIAS', [Object.assign({ CODIGO: cod, UND_COMPRA: und }, cambios)]);
    return '1 ' + und + ' = ' + factor + ' ' + U_(m.UND);
  });
}

function eliminarEquivalencia(token, codigo, und) {
  auth_(token, ['ADMIN']);
  return conBloqueo_(() => {
    const sh = hojaAuto_('EQUIVALENCIAS'), v = sh.getDataRange().getValues(), head = v[0].map(h => String(h).trim());
    const iC = head.indexOf('CODIGO'), iU = head.indexOf('UND_COMPRA');
    const r = v.findIndex((f, i) => i > 0 && U_(f[iC]) === U_(codigo) && U_(f[iU]) === U_(und));
    if (r < 1) throw new Error('No se encontró esa equivalencia.');
    sh.deleteRow(r + 1);   // los ingresos ya registrados guardan su propio factor: no cambian
    return true;
  });
}


/* ---------------- Correo (avisos automáticos) ---------------- */

/** Correos de los usuarios activos que cumplen el filtro. Sin correo registrado, no se avisa a nadie. */
function correos_(filtro) {
  try {
    return leer_('USUARIOS').filter(u => U_(u.ACTIVO) !== 'NO' && S_(u.CORREO) && filtro(u))
                            .map(u => S_(u.CORREO)).filter((c, i, a) => a.indexOf(c) === i);
  } catch (e) { return []; }
}

/** Envía un aviso. Nunca interrumpe el registro: si el correo falla, el documento ya quedó guardado. */
function enviarCorreo_(dest, asunto, cuerpo) {
  if (!dest || !dest.length) return false;
  try {
    MailApp.sendEmail({ to: dest.join(','), subject: asunto, body: cuerpo + '\n\n--\nControl Almacén\n' + urlApp_() });
    return true;
  } catch (e) { return false; }
}

function urlApp_() { try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; } }

/** Avisa al área dueña de la orden que su material llegó al almacén. */
function avisarIngreso_(cab, items, doc) {
  if (U_(cab.tipo) !== 'INGRESO') return;
  const area = U_(cab.area); if (!area) return;
  const dest = correos_(u => U_(u.ROL) === 'AREA' && U_(u.AREA) === area);
  if (!dest.length) return;
  const mat = leer_('MATERIALES'), nom = {}; mat.forEach(m => nom[U_(m.CODIGO)] = m.DESCRIPCION + ' (' + m.UND + ')');
  const lineas = items.map(it => '  • ' + (nom[U_(it.codigo)] || it.codigo) + ': ' + (it._q != null ? it._q : it.cant)).join('\n');
  enviarCorreo_(dest, 'Llegó material para ' + area + ' · ' + doc,
    'Ingresó material al almacén para tu área.\n\nDocumento: ' + doc +
    (cab.orc ? '\nOrden de compra: ' + S_(cab.orc) : '') + (cab.req ? '\nRequerimiento: ' + U_(cab.req) : '') +
    (cab.proveedor ? '\nProveedor: ' + U_(cab.proveedor) : '') + '\n\n' + lineas +
    '\n\nYa puedes registrar tu solicitud de material en el sistema.');
}

/* ---------------- Solicitudes de material ---------------- */

/** Enviada → Vista (almacén la abrió) → Aprobada (material separado) → Entregada parcial / Entregada; o Rechazada / Anulada. */
const EST_SOL = { ENVIADA: 'ENVIADA', VISTA: 'VISTA', APROBADA: 'APROBADA', PARCIAL: 'PARCIAL', ENTREGADA: 'ENTREGADA', RECHAZADA: 'RECHAZADA', ANULADA: 'ANULADA', CERRADA: 'CERRADA' };
const CERRADOS = [EST_SOL.ENTREGADA, EST_SOL.RECHAZADA, EST_SOL.ANULADA, EST_SOL.CERRADA];   // CERRADA = almacén dio por terminado lo pendiente (no recogió)
const ahora_ = () => Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');

function solicitudes_() { hojaAuto_('SOLICITUDES'); return leer_('SOLICITUDES'); }

/** Lo ya pedido y aún no atendido de cada orden, para no comprometer dos veces el mismo saldo. */
function reservado_(sol, excluirDoc, L) {
  const r = {};
  sol.forEach(x => {
    const e = U_(x.ESTADO);
    if (CERRADOS.indexOf(e) >= 0) return;
    if (excluirDoc && U_(x.DOC) === U_(excluirDoc)) return;
    const falta = N_(x.CANT) - N_(x.ATENDIDO); if (falta <= 0) return;
    const k = solKey_(x, L);
    r[k] = (r[k] || 0) + falta;
  });
  return r;
}

/**
 * De dónde sale cada línea de solicitud:
 *  'REQ|req|codigo' = cualquier orden de ese requerimiento (almacén elige la orden al entregar);
 *  'MAT|codigo'     = stock general (órdenes sin área: antiguas o pasadas con LG);
 *  id de lote       = solicitudes antiguas que ya pedían una orden fija.
 */
function solKey_(x, L) {
  const req = U_(x.REQ), cod = U_(x.CODIGO), lote = S_(x.LOTE);
  if (req && req !== 'STOCK') return 'REQ|' + req + '|' + cod;
  if (!req && lote) {
    // solicitudes antiguas pedidas a una orden fija: se completan con cualquier orden de su mismo REQ (o stock general)
    const l = L && L[lote];
    if (!l) return lote;
    return l.AREA && S_(l.REQ) && U_(l.REQ) !== 'STOCK' ? 'REQ|' + U_(l.REQ) + '|' + cod : 'MAT|' + cod;
  }
  return 'MAT|' + cod;
}

const porFecha_ = (a, b) => String(a.FECHA).localeCompare(String(b.FECHA)) || (N_(a.ID) - N_(b.ID)) || String(a.ID).localeCompare(String(b.ID));

/** Órdenes (lotes) de las que puede salir una clave de solicitud, la más antigua primero. */
function poolSol_(L, k) {
  if (L[k]) return [L[k]];
  const p = k.split('|');
  return Object.values(L).filter(l => p[0] === 'REQ' ? U_(l.REQ) === p[1] && l.AREA && U_(l.CODIGO) === p[2] : !l.AREA && U_(l.CODIGO) === p[1]).sort(porFecha_);
}

/** Lo reservado por solicitudes, repartido sobre cada orden (la más antigua primero). */
function reservaPorLote_(L, res) {
  const r = {}, ks = Object.keys(res);
  ks.filter(k => L[k]).forEach(k => r[k] = (r[k] || 0) + res[k]);
  ks.filter(k => !L[k]).forEach(k => {
    let q = res[k];
    poolSol_(L, k).forEach(l => { const u = Math.min(Math.max(l.SALDO - (r[l.ID] || 0), 0), q); if (u > 0) { r[l.ID] = (r[l.ID] || 0) + u; q -= u; } });
  });
  return r;
}

/** Cuánto se puede pedir todavía de una clave (saldo de sus órdenes menos lo ya solicitado y pendiente). */
function dispSol_(L, res, k, stockTotal) {
  const pool = poolSol_(L, k);
  let s = pool.reduce((a, l) => a + Math.max(l.SALDO, 0), 0);
  if (k.indexOf('MAT|') === 0) {     // material con saldo que no está en ninguna orden (ajustes, stock inicial)
    const cod = k.slice(4), enLotes = Object.values(L).filter(l => U_(l.CODIGO) === cod).reduce((a, l) => a + Math.max(l.SALDO, 0), 0);
    s += Math.max(0, N_(stockTotal) - enLotes);
  }
  const directo = L[k] ? 0 : pool.reduce((a, l) => a + N_(res[l.ID]), 0);
  return s - directo - N_(res[k]);
}

/**
 * Registra una solicitud de material (documento SM). El área solo puede pedir de sus propias órdenes.
 * cab = {fecha, area, receptor, responsable, obra, motivo, metrado, lotes, mz, uso, obs}
 * items = [{codigo, cant, req}]: req = requerimiento del que se pide, o 'STOCK' (stock general). Almacén elige la orden al entregar.
 */
function registrarSolicitud(token, cab, items) {
  const ses = auth_(token, PIDEN);
  return conBloqueo_(() => {
    if (!items || !items.length) throw new Error('La solicitud no tiene materiales.');
    const ent = leer_('ENTIDADES');
    const area = ses.rol === 'AREA' ? U_(ses.area) : entidad_(ent, 'AREA', cab.area, true, 'áreas');
    if (!area) throw new Error('Tu usuario no tiene un área asignada. Avisa al administrador.');
    const receptor = entidad_(ent, 'CONTRATISTA', cab.receptor, false, 'contratistas / receptores');
    const obra = entidad_(ent, 'OBRA', cab.obra, false, 'obras');
    if (!S_(cab.motivo)) throw new Error('Escribe el motivo de la solicitud.');
    const nroArea = U_(cab.nroArea);
    // préstamo: el área pide material de otra área u obra/etapa; almacén lo entrega con un vale de préstamo y vuelve a su orden
    const prestamo = !!cab.prestamo, fdev = prestamo ? fecha_(cab.fechaDev) : '';
    if (prestamo && !/^\d{4}-\d{2}-\d{2}$/.test(S_(cab.fechaDev))) throw new Error('Indica la fecha en que se devolverá el préstamo.');
    if (prestamo && S_(cab.fechaDev) < S_(cab.fecha || hoy_())) throw new Error('La fecha de devolución no puede ser anterior a la de la solicitud.');
    const duenos = {};

    const mat = leer_('MATERIALES'), porCod = {}; mat.forEach(m => porCod[U_(m.CODIGO)] = m);
    const mov = leer_('MOVIMIENTOS'), L = lotes_(mov);
    const stock = {}; calcularStock_(mat, mov).forEach(x => stock[U_(x.CODIGO)] = x);
    const sol = solicitudes_(), res = reservado_(sol, null, L), pedido = {};

    items.forEach(it => {
      const k = U_(it.codigo), m = porCod[k], lote = S_(it.lote), q = Number(it.cant);
      if (!m) throw new Error('El material ' + it.codigo + ' no existe en MATERIALES.');
      if (!(q > 0)) throw new Error('Cantidad no válida para ' + m.DESCRIPCION + '.');
      if (entera_(m.UND) && Math.abs(q - Math.round(q)) > 1e-9) throw new Error(m.DESCRIPCION + ' se cuenta en ' + U_(m.UND) + ' enteras.');
      let req = U_(it.req);
      if (lote && !req) {                 // compatibilidad: pedido a una orden fija
        if (!L[lote] || U_(L[lote].CODIGO) !== k) throw new Error('La orden elegida no corresponde a ' + m.DESCRIPCION + '.');
        if (ses.rol === 'AREA' && U_(L[lote].AREA) && U_(L[lote].AREA) !== area)
          throw new Error('Esa orden de ' + m.DESCRIPCION + ' es de ' + L[lote].AREA + '. Pide de una orden de tu área; si necesitas material de otra área, almacén lo registra como préstamo.');
      } else if (!req || req === 'STOCK GENERAL') req = 'STOCK';
      // un REQ cuyas órdenes no tienen área ya es stock general
      if (req && req !== 'STOCK' && !poolSol_(L, solKey_({ REQ: req, CODIGO: k })).length && Object.values(L).some(l => !l.AREA && U_(l.REQ) === req && U_(l.CODIGO) === k)) req = 'STOCK';
      it._req = req; it._lote = req ? '' : lote;
      const kk = solKey_({ REQ: req, LOTE: it._lote, CODIGO: k }, L);
      if (req && req !== 'STOCK') {
        const pool = poolSol_(L, kk);
        if (!pool.length) throw new Error('No hay órdenes de ' + m.DESCRIPCION + ' con el requerimiento ' + req + '.');
        const otra = pool.find(l => U_(l.AREA) && U_(l.AREA) !== area);
        if (prestamo) {
          const propio = obra ? pool.every(l => U_(l.OBRA) === obra) : pool.every(l => U_(l.AREA) === area);
          if (propio) throw new Error('El requerimiento ' + req + ' de ' + m.DESCRIPCION + ' ya es de ' + (obra || area) + ': pídelo como solicitud normal, no como préstamo.');
          pool.forEach(l => { if (U_(l.AREA) && U_(l.AREA) !== area) (duenos[U_(l.AREA)] = duenos[U_(l.AREA)] || []).push(m.DESCRIPCION + ' (' + req + (l.OBRA ? ' · ' + l.OBRA : '') + ')'); });
        } else if (ses.rol === 'AREA' && otra && !pool.some(l => U_(l.AREA) === area))
          throw new Error('El requerimiento ' + req + ' de ' + m.DESCRIPCION + ' es de ' + otra.AREA + '. Pide de un requerimiento de tu área o de stock general; si necesitas material de otra área o etapa, marca «Es préstamo de otra área / etapa».');
      }
      pedido[kk] = (pedido[kk] || 0) + q;
    });
    Object.keys(pedido).forEach(kk => {
      const cod = L[kk] ? U_(L[kk].CODIGO) : kk.split('|').pop(), d = porCod[cod], disp = dispSol_(L, res, kk, (stock[cod] || {}).SALDO);
      if (pedido[kk] > disp + 1e-9) {
        const p = kk.split('|'), ya = N_(res[kk]);
        throw new Error('Solo quedan ' + Math.max(0, disp) + ' ' + d.UND + ' de ' + d.DESCRIPCION +
          (p[0] === 'REQ' ? ' en el requerimiento ' + p[1] : p[0] === 'MAT' ? ' en stock general' : ' en la orden ' + (L[kk].REQ || L[kk].ORC || L[kk].DOC)) +
          (ya ? ' (hay ' + ya + ' ya solicitados y pendientes de entrega).' : '.'));
      }
    });

    if (nroArea) {
      const rep = sol.find(x => U_(x.NRO_AREA) === nroArea && U_(x.AREA) === area && U_(x.ESTADO) !== EST_SOL.ANULADA);
      if (rep) throw new Error('La solicitud ' + nroArea + ' de ' + area + ' ya fue registrada como ' + rep.DOC + '.');
    }
    const doc = siguienteDoc_(sol, 'SM');
    let id = sol.reduce((a, x) => Math.max(a, N_(x.ID)), 0);
    const f = fecha_(cab.fecha), ahora = ahora_();
    const filas = items.map(it => {
      const m = porCod[U_(it.codigo)];
      return {
        ID: ++id, DOC: doc, NRO_AREA: nroArea, ORIGEN: U_(cab.origen) === 'IMPORTADA' ? 'IMPORTADA' : 'SISTEMA', FECHA: f, AREA: area, SOLICITANTE: S_(ses.nombre), RECEPTOR: receptor, RESPONSABLE: U_(cab.responsable),
        OBRA: obra, CONTRATO: contrato_(cab.contrato), MOTIVO: S_(cab.motivo), METRADO: S_(cab.metrado), LOTES_OBRA: S_(cab.lotes), MZ: U_(cab.mz), USO: U_(cab.uso),
        CODIGO: m.CODIGO, DESCRIPCION: m.DESCRIPCION, UND: m.UND, CANT: Number(it.cant), LOTE: it._lote, REQ: it._req,
        ATENDIDO: 0, ESTADO: EST_SOL.ENVIADA, DOC_SAL: '', OBS: S_(cab.obs), USUARIO: ses.usuario, REGISTRADO: ahora,
        PRESTAMO: prestamo ? 'SI' : '', FECHA_DEV: fdev
      };
    });
    agregarFilas_('SOLICITUDES', filas);
    enviarCorreo_(correos_(u => ESCRIBEN.indexOf(U_(u.ROL)) >= 0 && U_(u.USUARIO) !== U_(ses.usuario)), 'Nueva solicitud de material ' + doc + (nroArea ? ' (' + nroArea + ')' : '') + ' · ' + area,
      area + ' solicita material.\n\nSolicitud: ' + doc + (nroArea ? '\nN° del área: ' + nroArea : '') + '\nMotivo: ' + S_(cab.motivo) +
      (receptor ? '\nReceptor: ' + receptor : '') + (contrato_(cab.contrato) ? '\nContrato: ' + contrato_(cab.contrato) : '') + '\nMateriales: ' + filas.length +
      '\n\nEntra al sistema para atenderla.');
    // el área dueña del material se entera de que se lo están pidiendo prestado
    Object.keys(duenos).filter(a => a !== area).forEach(a => enviarCorreo_(correos_(u => U_(u.ROL) === 'AREA' && U_(u.AREA) === a),
      area + (obra ? ' (' + obra + ')' : '') + ' pide prestado material de ' + a + ' · ' + doc,
      area + (obra ? ' (' + obra + ')' : '') + ' pide prestado material de tus órdenes.\n\nSolicitud: ' + doc + '\nMotivo: ' + S_(cab.motivo) +
      '\nDevolverá el: ' + S_(cab.fechaDev) + '\nMateriales: ' + uniq_(duenos[a]).join('; ') +
      '\n\nAlmacén lo entregará como préstamo y anotará quién lo autorizó. Si no estás de acuerdo, avisa a almacén.'));
    return doc;
  });
}

/** Escribe cambios en las filas de una solicitud. cambios(fila) devuelve {COLUMNA: valor} o null. */
function escribirSolicitud_(doc, cambios) {
  const sh = hojaAuto_('SOLICITUDES'); asegurarEncabezados_(sh, 'SOLICITUDES');
  const v = sh.getDataRange().getValues(), head = v[0].map(h => String(h).trim());
  const iDoc = head.indexOf('DOC'), iId = head.indexOf('ID');
  let n = 0;
  for (let r = 1; r < v.length; r++) {
    if (U_(v[r][iDoc]) !== U_(doc)) continue;
    const c = cambios({ ID: N_(v[r][iId]), fila: r });
    if (!c) continue;
    Object.keys(c).forEach(k => {
      const j = head.indexOf(k); if (j < 0) return;
      const cell = sh.getRange(r + 1, j + 1);
      if (TEXTO.SOLICITUDES.indexOf(k) >= 0) cell.setNumberFormat('@');   // la hora 09:00 o la fecha quedan como texto
      cell.setValue(c[k]);
    });
    n++;
  }
  if (!n) throw new Error('No se encontró la solicitud ' + doc + '.');
  return n;
}

function cabeceraSol_(sol, doc) {
  const f = sol.filter(x => U_(x.DOC) === U_(doc));
  if (!f.length) throw new Error('No se encontró la solicitud ' + doc + '.');
  return f;
}

/**
 * Almacén atiende la solicitud: genera el vale de salida con lo que realmente entrega.
 * entregas = [{id, cant, lote}]: una línea puede salir de varias órdenes del mismo requerimiento (compras parciales).
 * Lo no entregado queda pendiente.
 */
function atenderSolicitud(token, doc, entregas, obs, autoriza) {
  const ses = auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const sol = solicitudes_(), filas = cabeceraSol_(sol, doc), h = filas[0];
    if ([EST_SOL.RECHAZADA, EST_SOL.ANULADA, EST_SOL.CERRADA].indexOf(U_(h.ESTADO)) >= 0) throw new Error('La solicitud ' + doc + ' ya fue ' + U_(h.ESTADO).toLowerCase() + '.');
    if (filas.every(x => U_(x.ESTADO) === EST_SOL.ENTREGADA)) throw new Error('La solicitud ' + doc + ' ya fue entregada completa.');
    if (filas.every(x => CERRADOS.indexOf(U_(x.ESTADO)) >= 0)) throw new Error('La solicitud ' + doc + ' ya está cerrada.');
    const porId = {}; filas.forEach(x => porId[N_(x.ID)] = x);
    const L = lotes_(leer_('MOVIMIENTOS')), dar = {}, partes = {};
    (entregas || []).forEach(e => {
      const id = N_(e.id), q = Number(e.cant), x = porId[id]; if (!(q > 0)) return;
      if (!x) throw new Error('Esa línea no pertenece a la solicitud ' + doc + '.');
      if (CERRADOS.indexOf(U_(x.ESTADO)) >= 0) throw new Error(x.DESCRIPCION + ' ya está cerrado en la solicitud ' + doc + '.');
      const k = solKey_(x, L);
      let lote = S_(e.lote);
      if (!lote && S_(x.LOTE) && !S_(x.REQ) && L[S_(x.LOTE)] && L[S_(x.LOTE)].SALDO > 0) lote = S_(x.LOTE);   // solicitud antigua: primero su orden original
      if (L[k]) lote = k;                                   // solicitud antigua: orden fija
      if (lote) {
        const l = L[lote];
        if (!l || U_(l.CODIGO) !== U_(x.CODIGO)) throw new Error('La orden elegida no corresponde a ' + x.DESCRIPCION + '.');
        if (k.indexOf('REQ|') === 0 && U_(l.REQ) !== k.split('|')[1])
          throw new Error('La orden ' + (l.ORC || l.DOC) + ' no es del requerimiento ' + k.split('|')[1] + ' (' + x.DESCRIPCION + ').');
      } else if (k.indexOf('REQ|') === 0) throw new Error('Elige de qué orden del requerimiento ' + k.split('|')[1] + ' sale ' + x.DESCRIPCION + '.');
      dar[id] = (dar[id] || 0) + q;
      const pk = id + '|' + lote; partes[pk] = { id: id, lote: lote, cant: (partes[pk] ? partes[pk].cant : 0) + q };
    });
    if (!Object.keys(dar).length) throw new Error('Indica cuánto se entrega.');
    Object.keys(dar).forEach(id => {
      const x = porId[id]; if (!x) throw new Error('Esa línea no pertenece a la solicitud ' + doc + '.');
      const falta = N_(x.CANT) - N_(x.ATENDIDO);
      if (dar[id] > falta + 1e-9) throw new Error('De ' + x.DESCRIPCION + ' solo quedan ' + falta + ' ' + x.UND + ' por entregar.');
    });

    const cab = { tipo: 'SALIDA', fecha: hoy_(), area: h.AREA, contratista: h.RECEPTOR, obra: h.OBRA, contrato: h.CONTRATO, uso: h.USO,
                  solicitante: h.RESPONSABLE || h.SOLICITANTE, obs: S_(obs) || ('Atiende solicitud ' + doc + (h.NRO_AREA ? ' (' + h.NRO_AREA + ')' : '')) };
    if (!S_(cab.contratista)) throw new Error('La solicitud no indica a quién se entrega. Edita el receptor antes de generar el vale.');
    const items = Object.values(partes).map(p => ({ codigo: porId[p.id].CODIGO, cant: p.cant, lote: p.lote, _id: p.id }));
    // préstamo: lo que sale de órdenes de otra área/etapa va en un vale de préstamo (vuelve a su orden); lo de stock general, en un vale de salida
    const general = it => { const l = L[S_(it.lote)]; return !l || (!U_(l.AREA) && (!S_(l.REQ) || U_(l.REQ) === 'STOCK')); };
    const esPre = U_(h.PRESTAMO) === 'SI', vPre = esPre ? items.filter(it => !general(it)) : [], vSal = items.filter(it => vPre.indexOf(it) < 0);
    if (vPre.length && !U_(autoriza)) throw new Error('Es un préstamo: escribe quién lo autorizó.');
    const valeDe = {};
    if (vPre.length) { const pr = crearDocumento_(ses, Object.assign({}, cab, { tipo: 'PRESTAMO', fechaDev: S_(h.FECHA_DEV).slice(0, 10) || hoy_(), autoriza: autoriza }), vPre);
                       vPre.forEach(it => valeDe[it._id] = (valeDe[it._id] || []).concat(pr)); }
    if (vSal.length) { const vs = crearDocumento_(ses, cab, vSal); vSal.forEach(it => valeDe[it._id] = (valeDe[it._id] || []).concat(vs)); }
    const vale = uniq_([].concat.apply([], Object.values(valeDe))).join(' ');

    const t = ahora_();
    escribirSolicitud_(doc, f => {
      const x = porId[f.ID]; if (!x) return null;
      const c = {};
      if (!S_(x.APROBADA_EN)) { c.APROBADA_POR = ses.nombre; c.APROBADA_EN = t; }      // entregar implica aprobar
      if (!S_(x.VISTA_EN)) { c.VISTA_POR = ses.nombre; c.VISTA_EN = t; }
      if (dar[f.ID]) {
        const att = N_(x.ATENDIDO) + dar[f.ID];
        const vs = uniq_(valeDe[f.ID] || []).join(' ');
        c.ATENDIDO = att; c.DOC_SAL = S_(x.DOC_SAL) ? S_(x.DOC_SAL) + ' ' + vs : vs;
        c.ESTADO = att + 1e-9 >= N_(x.CANT) ? EST_SOL.ENTREGADA : EST_SOL.PARCIAL;
        if (c.ESTADO === EST_SOL.ENTREGADA) { c.CERRADA_POR = ses.nombre; c.CERRADA_EN = t; }
      } else if (U_(x.ESTADO) !== EST_SOL.PARCIAL && CERRADOS.indexOf(U_(x.ESTADO)) < 0) c.ESTADO = N_(x.ATENDIDO) > 0 ? EST_SOL.PARCIAL : EST_SOL.APROBADA;
      return Object.keys(c).length ? c : null;
    });
    recalcular();
    enviarCorreo_(correos_(u => U_(u.USUARIO) === U_(h.USUARIO)), 'Tu solicitud ' + doc + (h.NRO_AREA ? ' (' + h.NRO_AREA + ')' : '') + ' fue entregada · ' + vale,
      'Almacén entregó material de tu solicitud ' + doc + ' con el vale de salida ' + vale + '.\n\nEntra al sistema para ver lo entregado y lo que queda pendiente.');
    return vale;
  });
}

function rechazarSolicitud(token, doc, motivo) {
  const ses = auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const m = S_(motivo); if (!m) throw new Error('Escribe por qué se rechaza.');
    const sol = solicitudes_(), filas = cabeceraSol_(sol, doc), h = filas[0];
    if (filas.some(x => N_(x.ATENDIDO) > 0)) throw new Error('La solicitud ' + doc + ' ya tiene entregas: no se puede rechazar.');
    const t = ahora_();
    escribirSolicitud_(doc, () => ({ ESTADO: EST_SOL.RECHAZADA, OBS: m, CERRADA_POR: ses.nombre, CERRADA_EN: t }));
    enviarCorreo_(correos_(u => U_(u.USUARIO) === U_(h.USUARIO)), 'Tu solicitud ' + doc + ' fue rechazada',
      'Almacén rechazó tu solicitud ' + doc + '.\n\nMotivo: ' + m);
    return true;
  });
}

/** Almacén abrió la solicitud por primera vez: queda como Vista, con quién y cuándo. */
function marcarVista(token, doc) {
  const ses = auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const filas = cabeceraSol_(solicitudes_(), doc);
    if (filas.some(x => S_(x.VISTA_EN))) return false;
    const t = ahora_();
    escribirSolicitud_(doc, f => ({ VISTA_POR: ses.nombre, VISTA_EN: t, ESTADO: EST_SOL.VISTA }));
    return true;
  });
}

/**
 * Almacén revisó el stock y separa el material: avisa al área que está lista para recoger.
 * recojo = {fecha, turno, dias}: cuándo debe pasar el contratista y cuántos días tiene de plazo (opcional).
 */
function aprobarSolicitud(token, doc, recojo) {
  const ses = auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const filas = cabeceraSol_(solicitudes_(), doc), h = filas[0];
    if (filas.some(x => CERRADOS.indexOf(U_(x.ESTADO)) >= 0 && U_(x.ESTADO) !== EST_SOL.ENTREGADA)) throw new Error('La solicitud ' + doc + ' ya está cerrada.');
    if (filas.some(x => S_(x.APROBADA_EN))) throw new Error('La solicitud ' + doc + ' ya estaba aprobada.');
    const t = ahora_(), rc = recojo_(recojo);
    escribirSolicitud_(doc, f => {
      const x = filas.find(z => N_(z.ID) === f.ID), c = Object.assign({ APROBADA_POR: ses.nombre, APROBADA_EN: t }, rc || {});
      if (!S_(x.VISTA_EN)) { c.VISTA_POR = ses.nombre; c.VISTA_EN = t; }
      if ([EST_SOL.ENVIADA, EST_SOL.VISTA].indexOf(U_(x.ESTADO)) >= 0) c.ESTADO = EST_SOL.APROBADA;
      return c;
    });
    enviarCorreo_(correos_(u => U_(u.USUARIO) === U_(h.USUARIO)), 'Tu solicitud ' + doc + (h.NRO_AREA ? ' (' + h.NRO_AREA + ')' : '') + ' fue aprobada',
      'Almacén aprobó tu solicitud ' + doc + '. El material está separado y listo para recoger.' + recojoTxt_(rc, h));
    return true;
  });
}

const TURNOS = ['MAÑANA', 'TARDE', 'TODO EL DÍA'];

/** Valida la programación de recojo. Devuelve las columnas a escribir o null si no se programó. */
function recojo_(r) {
  if (!r || !S_(r.fecha)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(S_(r.fecha))) throw new Error('Fecha de recojo no válida.');
  const hm = /^(\d{1,2}):(\d{2})/.exec(S_(r.hora)), hora = hm && +hm[1] < 24 && +hm[2] < 60 ? ('0' + (+hm[1])).slice(-2) + ':' + hm[2] : '';
  // con hora, el turno sale solo de la hora
  const turno = hora ? (hora < '13:00' ? 'MAÑANA' : 'TARDE') : TURNOS.indexOf(U_(r.turno)) >= 0 ? U_(r.turno) : 'TODO EL DÍA', dias = Math.max(0, Math.round(N_(r.dias)));
  const lim = fecha_(S_(r.fecha)); lim.setDate(lim.getDate() + dias);
  return { RECOJO_FECHA: S_(r.fecha), RECOJO_TURNO: turno, RECOJO_HORA: hora, RECOJO_LIMITE: Utilities.formatDate(lim, Session.getScriptTimeZone(), 'yyyy-MM-dd') };
}

const fechaTxt_ = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(S_(iso)); return m ? m[3] + '/' + m[2] + '/' + m[1] : S_(iso); };
function recojoTxt_(rc, h) {
  if (!rc) return '';
  return '\n\nRecojo: ' + fechaTxt_(rc.RECOJO_FECHA) + (rc.RECOJO_HORA ? ' a las ' + rc.RECOJO_HORA : '') + ' (' + rc.RECOJO_TURNO.toLowerCase() + ')' +
    (rc.RECOJO_LIMITE !== rc.RECOJO_FECHA ? ', a más tardar el ' + fechaTxt_(rc.RECOJO_LIMITE) : '') +
    (h && h.RECEPTOR ? '\nRecoge: ' + h.RECEPTOR : '') + '\nPasado ese plazo, almacén puede liberar el material separado.';
}

/** Cambia la fecha o el plazo de recojo de una solicitud aprobada. */
function reprogramarRecojo(token, doc, recojo) {
  const ses = auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const filas = cabeceraSol_(solicitudes_(), doc), h = filas[0];
    if (!filas.some(x => S_(x.APROBADA_EN))) throw new Error('Primero aprueba la solicitud ' + doc + '.');
    if (filas.every(x => CERRADOS.indexOf(U_(x.ESTADO)) >= 0)) throw new Error('La solicitud ' + doc + ' ya está cerrada.');
    const rc = recojo_(recojo); if (!rc) throw new Error('Indica la fecha de recojo.');
    escribirSolicitud_(doc, () => rc);
    enviarCorreo_(correos_(u => U_(u.USUARIO) === U_(h.USUARIO)), 'Nueva fecha de recojo · ' + doc + (h.NRO_AREA ? ' (' + h.NRO_AREA + ')' : ''),
      'Almacén reprogramó el recojo de tu solicitud ' + doc + '.' + recojoTxt_(rc, h) + '\n\nReprogramado por: ' + ses.nombre);
    return true;
  });
}

/** Almacén da por terminado lo que falta entregar (por ejemplo, no recogieron a tiempo): libera lo separado. */
function cerrarSolicitud(token, doc, motivo) {
  const ses = auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const m = S_(motivo); if (!m) throw new Error('Escribe por qué se cierra lo pendiente.');
    const filas = cabeceraSol_(solicitudes_(), doc), h = filas[0];
    const abiertas = filas.filter(x => CERRADOS.indexOf(U_(x.ESTADO)) < 0);
    if (!abiertas.length) throw new Error('La solicitud ' + doc + ' ya está cerrada.');
    const t = ahora_();
    escribirSolicitud_(doc, f => abiertas.some(x => N_(x.ID) === f.ID) ? { ESTADO: EST_SOL.CERRADA, OBS: m, CERRADA_POR: ses.nombre, CERRADA_EN: t } : null);
    enviarCorreo_(correos_(u => U_(u.USUARIO) === U_(h.USUARIO)), 'Solicitud ' + doc + ' cerrada con pendientes',
      'Almacén cerró lo pendiente de tu solicitud ' + doc + ' y liberó el material separado.\n\nMotivo: ' + m + '\n\nSi aún lo necesitas, registra una nueva solicitud.');
    return true;
  });
}

/** El área anula su propia solicitud mientras nadie la haya atendido. */
function anularSolicitud(token, doc) {
  const ses = auth_(token, PIDEN);
  return conBloqueo_(() => {
    const filas = cabeceraSol_(solicitudes_(), doc), h = filas[0];
    if (ses.rol === 'AREA' && U_(h.USUARIO) !== U_(ses.usuario)) throw new Error('Solo puedes anular tus propias solicitudes.');
    if (filas.some(x => N_(x.ATENDIDO) > 0)) throw new Error('La solicitud ' + doc + ' ya tiene entregas: no se puede anular.');
    if (ses.rol === 'AREA' && filas.some(x => S_(x.APROBADA_EN))) throw new Error('Almacén ya aprobó la solicitud ' + doc + ': pide a almacén que la rechace si ya no la necesitas.');
    const t = ahora_();
    escribirSolicitud_(doc, () => ({ ESTADO: EST_SOL.ANULADA, CERRADA_POR: ses.nombre, CERRADA_EN: t }));
    return true;
  });
}

function hoy_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

/* ---------------- Lista maestra (contratistas, proveedores, áreas, obras) ---------------- */

/** Clave para detectar nombres repetidos escritos distinto: G&S = GYS = G & S S.A.C. */
function claveNombre_(s) {
  return U_(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'Y')
    .replace(/\b(S\.?\s?A\.?\s?C\.?|S\.?\s?R\.?\s?L\.?|E\.?\s?I\.?\s?R\.?\s?L\.?|S\.?\s?A\.?\s?A\.?|S\.?\s?A\.?)\s*$/, '')
    .replace(/[^A-Z0-9]/g, '');
}

/** Nueva entidad o actualiza documento/contacto/activo. d: {tipo, nombre, documento, contacto, activo} */
function guardarEntidad(token, d) {
  auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const tipo = U_(d.tipo), nombre = U_(d.nombre).replace(/\s+/g, ' ');
    if (!TIPOS_ENTIDAD[tipo]) throw new Error('Tipo no válido.');
    if (nombre.length < 2) throw new Error('Escribe el nombre.');
    const sh = hoja_('ENTIDADES'), v = sh.getDataRange().getValues(), h = v[0].map(String), c = n => h.indexOf(n);
    const i = v.findIndex((r, k) => k > 0 && U_(r[c('TIPO')]) === tipo && U_(r[c('NOMBRE')]) === nombre);
    if (i < 1) {
      const igual = v.find((r, k) => k > 0 && U_(r[c('TIPO')]) === tipo && claveNombre_(r[c('NOMBRE')]) === claveNombre_(nombre));
      if (igual) throw new Error('Ya existe "' + igual[c('NOMBRE')] + '", que parece el mismo. Usa ese nombre.');
      agregarFilas_('ENTIDADES', [{ TIPO: tipo, NOMBRE: nombre, DOCUMENTO: S_(d.documento), CONTACTO: S_(d.contacto), ACTIVO: 'SI' }]);
    } else {
      sh.getRange(i + 1, c('DOCUMENTO') + 1).setValue(S_(d.documento));
      sh.getRange(i + 1, c('CONTACTO') + 1).setValue(S_(d.contacto));
      sh.getRange(i + 1, c('ACTIVO') + 1).setValue(d.activo === false ? 'NO' : 'SI');
    }
    return nombre;
  });
}

/** Une dos nombres que son el mismo: cambia "de" por "a" en todo MOVIMIENTOS y borra "de" de la lista (solo administrador). */
function unificarEntidad(token, tipo, de, a) {
  auth_(token, ['ADMIN']);
  return conBloqueo_(() => {
    tipo = U_(tipo); de = U_(de); a = U_(a);
    if (!TIPOS_ENTIDAD[tipo] || !de || !a || de === a) throw new Error('Elige dos nombres distintos.');
    const se = hoja_('ENTIDADES'), ve = se.getDataRange().getValues(), he = ve[0].map(String);
    const fila = ve.findIndex((r, k) => k > 0 && U_(r[he.indexOf('TIPO')]) === tipo && U_(r[he.indexOf('NOMBRE')]) === de);
    if (!ve.some((r, k) => k > 0 && U_(r[he.indexOf('TIPO')]) === tipo && U_(r[he.indexOf('NOMBRE')]) === a)) throw new Error(a + ' no está en la lista.');
    const sm = hoja_('MOVIMIENTOS'), vm = sm.getDataRange().getValues(), col = vm[0].map(String).indexOf(TIPOS_ENTIDAD[tipo]);
    let n = 0;
    if (col >= 0 && vm.length > 1) {
      const vals = vm.slice(1).map(r => { if (U_(r[col]) === de) { n++; return [a]; } return [r[col]]; });
      sm.getRange(2, col + 1, vals.length, 1).setValues(vals);
    }
    if (fila > 0) se.deleteRow(fila + 1);
    recalcular();
    return n;
  });
}

/* ---------------- Materiales ---------------- */

/** Material nuevo. El código sigue el prefijo de su categoría (ej. MET-ACERO-0011) o crea uno nuevo. */
function registrarMaterial(token, d) {
  auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const desc = U_(d.descripcion), cat = U_(d.categoria);
    if (!desc || !cat || !d.und) throw new Error('Completa descripción, categoría y unidad.');
    const mat = leer_('MATERIALES');
    if (mat.some(m => U_(m.DESCRIPCION) === desc)) throw new Error('Este material ya está registrado.');
    const codigo = U_(d.codigo) || nuevoCodigo_(mat, cat);
    if (mat.some(m => U_(m.CODIGO) === codigo)) throw new Error('El código ' + codigo + ' ya existe.');
    agregarFilas_('MATERIALES', [Object.assign({ CODIGO: codigo, DESCRIPCION: desc, CATEGORIA: cat, UND: canonUnd_(d.und), STOCK_MIN: N_(d.stockMin), UBICACION: U_(d.ubicacion) }, vidaDe_(d))]);
    recalcular();
    return codigo;
  });
}

/** Actualiza stock mínimo y ubicación; la unidad solo se cambia si el material aún no tiene movimientos. */
function actualizarMaterial(token, d) {
  auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const sh = hoja_('MATERIALES'), v = sh.getDataRange().getValues();
    const fila = v.findIndex((r, i) => i > 0 && U_(r[0]) === U_(d.codigo));
    if (fila < 1) throw new Error('No se encontró el material ' + d.codigo + '.');
    const und = d.und ? canonUnd_(d.und) : '';
    if (und && und !== U_(v[fila][3]) && und !== canonUnd_(v[fila][3])) {
      if (leer_('MOVIMIENTOS').some(m => U_(m.CODIGO) === U_(d.codigo)))
        throw new Error('No se puede cambiar la unidad: este material ya tiene movimientos en ' + U_(v[fila][3]) + '. Si logística compra en ' + und + ', agrega una equivalencia de compra.');
      sh.getRange(fila + 1, 4).setValue(und);
    }
    sh.getRange(fila + 1, 5, 1, 2).setValues([[N_(d.stockMin), U_(d.ubicacion)]]);
    escribirCampos_(sh, 'MATERIALES', fila, vidaDe_(d));
    recalcular();
    return d.codigo;
  });
}

function nuevoCodigo_(mat, cat) {
  const deCat = mat.filter(m => U_(m.CATEGORIA) === cat && /-\d{4}$/.test(String(m.CODIGO)));
  let pre;
  if (deCat.length) {
    const c = {}; deCat.forEach(m => { const p = String(m.CODIGO).replace(/-\d{4}$/, ''); c[p] = (c[p] || 0) + 1; });
    pre = Object.keys(c).sort((a, b) => c[b] - c[a])[0];
  } else {
    pre = cat.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'MAT';
  }
  const max = mat.filter(m => String(m.CODIGO).indexOf(pre + '-') === 0)
                 .reduce((a, m) => Math.max(a, parseInt(String(m.CODIGO).slice(-4), 10) || 0), 0);
  return pre + '-' + ('0000' + (max + 1)).slice(-4);
}

/* ---------------- Vida útil, perecibles y material dormido ---------------- */

/** Campos de vida útil validados desde el formulario: {vidaTipo, vidaDias, vidaFuente}. */
function vidaDe_(d) {
  const tipo = U_(d.vidaTipo), dias = Math.round(N_(d.vidaDias));
  if (!tipo) return { VIDA_TIPO: '', VIDA_DIAS: '', VIDA_FUENTE: '' };
  if (VIDA_TIPOS.indexOf(tipo) < 0) throw new Error('Tipo de vida útil no válido.');
  if (!(dias > 0)) throw new Error('Indica la vida útil en días (mayor que cero).');
  return { VIDA_TIPO: tipo, VIDA_DIAS: dias, VIDA_FUENTE: S_(d.vidaFuente) };
}

/** Escribe columnas por nombre en una fila (índice de getValues) de la hoja, agregando las que falten. */
function escribirCampos_(sh, nombre, fila, campos) {
  asegurarEncabezados_(sh, nombre);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  Object.keys(campos).forEach(h => { const j = head.indexOf(h); if (j >= 0) sh.getRange(fila + 1, j + 1).setValue(campos[h]); });
}

/**
 * Valores de partida (referenciales: confirmar con la ficha técnica de cada producto).
 * Se revisan en orden; gana la primera regla cuyo texto aparece en la descripción o categoría.
 */
const VIDA_SUGERIDA = [
  [/\bLIJA\b|\bDISCO\b|\bBROCA\b|HOJA DE SIERRA/, '', 0, 'Consumible: no se controla vida útil'],
  [/PEGAMENTO (OATEY|PVC|PARA PVC)|CEMENTO (PVC|PARA PVC)/, 'PERECIBLE', 365, 'Pegamento PVC'],
  [/\bCEMENTO\b/, 'PERECIBLE', 90, 'Cemento en bolsa'],
  [/\bYESO\b/, 'PERECIBLE', 90, 'Yeso en bolsa'],
  [/\bCAL\b/, 'PERECIBLE', 180, 'Cal'],
  [/PEGAMENTO|ADHESIVO|CHEMITA|BONDEX|FRAGUA|PORCELANATO EN POLVO/, 'PERECIBLE', 365, 'Pegamento / fragua'],
  [/ADITIVO|IMPERMEABILIZ|SIKA|CURADOR|DESMOLDANTE|ACELERANTE|QUIMICO/, 'PERECIBLE', 365, 'Aditivo / químico'],
  [/SILICONA|SELLADOR/, 'PERECIBLE', 365, 'Silicona / sellador'],
  [/IMPRIMANTE|BASE PARA PARED/, 'PERECIBLE', 365, 'Imprimante'],
  [/PINTURA|LATEX|TEMPLE|ESMALTE|BARNIZ|LACA/, 'PERECIBLE', 730, 'Pintura'],
  [/DIESEL|PETROLEO|GASOLINA|COMBUSTIBLE/, 'PERECIBLE', 180, 'Combustible'],
  [/ELECTRODO|SOLDADURA/, 'REVISION', 180, 'Electrodo (humedad)'],
  [/FIERRO|ALAMBRE|CLAVO|ACERO|GALVANIZADO|PLATINA|ANGULO/, 'REVISION', 180, 'Acero (óxido)'],
  [/CABLE|CONDUCTOR/, 'REVISION', 365, 'Cable'],
  [/\bPALA\b|\bPICO\b|CARRETILLA|BUGGY|BARRETA|COMBA|MARTILLO|SERRUCHO|CINCEL|ALICATE|LLAVE STILSON/, 'HERRAMIENTA', 365, 'Herramienta manual'],
  [/BADILEJO|FROTACHO|PLANCHA DE BATIR|ESPATULA|NIVEL DE MANO|WINCHA|REGLA DE ALUMINIO|ESCOBA|BROCHA|RODILLO/, 'HERRAMIENTA', 180, 'Herramienta manual']
];
const FUENTE_SUGERIDA = 'Referencial: confirmar con ficha técnica';

function sinTildes_(s) { return U_(s).normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

/** Aplica la vida útil sugerida a los materiales que aún no tienen una (solo administrador). No toca lo ya escrito. */
function aplicarVidaSugerida(token) {
  auth_(token, ['ADMIN']);
  return conBloqueo_(() => {
    const sh = hoja_('MATERIALES'); asegurarEncabezados_(sh, 'MATERIALES');
    const v = sh.getDataRange().getValues(), head = v[0].map(h => String(h).trim());
    const iD = head.indexOf('DESCRIPCION'), iC = head.indexOf('CATEGORIA'), iT = head.indexOf('VIDA_TIPO');
    let n = 0; const lista = [];
    for (let i = 1; i < v.length; i++) {
      if (!S_(v[i][0]) || S_(v[i][iT])) continue;
      const txt = sinTildes_(v[i][iD]) + ' | ' + sinTildes_(v[i][iC]);
      const r = VIDA_SUGERIDA.find(x => x[0].test(txt)); if (!r || !r[1]) continue;
      escribirCampos_(sh, 'MATERIALES', i, { VIDA_TIPO: r[1], VIDA_DIAS: r[2], VIDA_FUENTE: FUENTE_SUGERIDA + ' (' + r[3] + ')' });
      n++; lista.push(v[i][iD]);
    }
    return { n: n, lista: lista };
  });
}

/** Estado de vida útil de un lote con saldo: Vencido / Por vencer / Revisar / Reponer, con la fecha que lo explica. */
function vidaLote_(l, m, hoy) {
  const tipo = U_(m && m.VIDA_TIPO), d = N_(m && m.VIDA_DIAS);
  if (!tipo || l.SALDO <= 0) return null;
  const base = S_(l.FECHA).slice(0, 10), mas = n => { const x = fecha_(base); x.setDate(x.getDate() + n); return Utilities.formatDate(x, Session.getScriptTimeZone(), 'yyyy-MM-dd'); };
  const dif = f => Math.round((fecha_(f) - fecha_(hoy)) / 864e5);
  if (tipo === 'PERECIBLE') {
    const vence = /^\d{4}-\d{2}-\d{2}/.test(S_(l.VENCE)) ? S_(l.VENCE).slice(0, 10) : (d ? mas(d) : '');
    if (!vence) return null;
    const r = dif(vence);
    return r < 0 ? { estado: 'Vencido', fecha: vence, dias: r } : r <= DIAS_POR_VENCER ? { estado: 'Por vencer', fecha: vence, dias: r } : null;
  }
  if (!d) return null;
  const f = mas(d), r = dif(f);
  return r <= 0 ? { estado: tipo === 'HERRAMIENTA' ? 'Evaluar reposición' : 'Revisar', fecha: f, dias: r } : null;
}

/**
 * Pasa a stock general el saldo (todo o parte) de órdenes de un área o requerimiento.
 * items = [{lote, cant}], motivo obligatorio. Avisa por correo al área dueña.
 */
function pasarAStockGeneral(token, items, motivo) {
  const ses = auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    if (!items || !items.length) throw new Error('No hay órdenes para pasar.');
    if (!S_(motivo)) throw new Error('Indica el motivo (por ejemplo: saldo sin uso desde hace 3 meses).');
    const mov = leer_('MOVIMIENTOS'), L = lotes_(mov), res = reservaPorLote_(L, reservado_(solicitudes_(), null, L));
    const usado = {};
    items.forEach(it => {
      const l = L[S_(it.lote)], q = Number(it.cant);
      if (!l) throw new Error('No se encontró la orden elegida.');
      if (!l.AREA && (!l.REQ || U_(l.REQ) === 'STOCK')) throw new Error('La orden ' + (l.ORC || l.DOC) + ' de ' + l.DESCRIPCION + ' ya es stock general.');
      if (!(q > 0)) throw new Error('Cantidad no válida para ' + l.DESCRIPCION + '.');
      if (entera_(l.UND) && Math.abs(q - Math.round(q)) > 1e-9) throw new Error(l.DESCRIPCION + ' se cuenta en ' + U_(l.UND) + ' enteras.');
      usado[l.ID] = (usado[l.ID] || 0) + q;
      const libre = l.SALDO - N_(res[l.ID]);
      if (usado[l.ID] > libre + 1e-9) throw new Error('La orden ' + (l.ORC || l.DOC) + ' de ' + l.DESCRIPCION + ' solo tiene ' + Math.max(0, libre) + ' ' + l.UND + ' libres' + (res[l.ID] ? ' (hay ' + res[l.ID] + ' pedidos en solicitudes abiertas)' : '') + '.');
    });
    const doc = siguienteDoc_(mov, 'LG');
    let id = mov.reduce((a, m) => Math.max(a, N_(m.ID)), 0);
    const f = new Date(), filas = items.map(it => {
      const l = L[S_(it.lote)], q = Number(it.cant);
      return { ID: ++id, DOC: doc, TIPO: 'LIBERACION', FECHA: f, CODIGO: l.CODIGO, DESCRIPCION: l.DESCRIPCION, UND: l.UND, CANT: q,
               PU: l.PU, TOTAL: Math.round(q * l.PU * 100) / 100, ORC: l.ORC, REQ: l.REQ, AREA: l.AREA, LOTE: l.ID,
               OBS: S_(motivo), USUARIO: ses.usuario, REGISTRADO: f };
    });
    agregarFilas_('MOVIMIENTOS', filas);
    recalcular();
    const porArea = {};
    filas.forEach(x => { if (x.AREA) (porArea[x.AREA] = porArea[x.AREA] || []).push(x); });
    Object.keys(porArea).forEach(a => {
      enviarCorreo_(correos_(u => U_(u.ROL) === 'AREA' && U_(u.AREA) === a),
        'Saldo de ' + a + ' pasó a stock general · ' + doc,
        'Almacén pasó a stock general este saldo de tu área. Desde ahora lo puede usar cualquier área.\n\nDocumento: ' + doc +
        '\nMotivo: ' + S_(motivo) + '\n\n' + porArea[a].map(x => '  • ' + x.DESCRIPCION + ': ' + x.CANT + ' ' + x.UND + ' (ORC ' + (x.ORC || 's/n') + (x.REQ ? ', ' + x.REQ : '') + ')').join('\n') +
        '\n\nSi aún lo necesitas, pídelo con una solicitud de material mientras haya stock.');
    });
    return doc;
  });
}

/** Resumen de alertas: lotes vencidos o por vencer, por revisar, y saldos dormidos por área. */
function alertas_() {
  const hoy = hoy_(), mat = leer_('MATERIALES'), mov = leer_('MOVIMIENTOS'), L = lotes_(mov), res = reservaPorLote_(L, reservado_(solicitudes_(), null, L));
  const porCod = {}; mat.forEach(m => porCod[U_(m.CODIGO)] = m);
  const vida = [], dormidos = [];
  Object.keys(L).forEach(id => {
    const l = L[id]; if (l.SALDO <= 0) return;
    const v = vidaLote_(l, porCod[U_(l.CODIGO)], hoy); if (v) vida.push(Object.assign({ l: l }, v));
    if (l.AREA && l.SALDO - N_(res[id]) > 0) {
      const sin = Math.round((fecha_(hoy) - fecha_(S_(l.ULT).slice(0, 10))) / 864e5);
      if (sin >= DIAS_DORMIDO) dormidos.push({ l: l, dias: sin, libre: l.SALDO - N_(res[id]) });
    }
  });
  return { vida: vida, dormidos: dormidos };
}

/** Correo semanal: a cada área, su material sin retirar; a almacén y administración, el resumen completo. */
function avisoSemanal() {
  const a = alertas_(), lin = x => '  • ' + x.l.DESCRIPCION + ': ' + x.l.SALDO + ' ' + x.l.UND + ' · ORC ' + (x.l.ORC || 's/n') + (x.l.REQ ? ' · ' + x.l.REQ : '');
  const porArea = {};
  a.dormidos.forEach(x => (porArea[x.l.AREA] = porArea[x.l.AREA] || []).push(x));
  Object.keys(porArea).forEach(ar => {
    enviarCorreo_(correos_(u => U_(u.ROL) === 'AREA' && U_(u.AREA) === ar), 'Material de ' + ar + ' sin retirar del almacén',
      'Este material de tu área lleva ' + DIAS_DORMIDO + ' días o más sin ninguna salida:\n\n' +
      porArea[ar].map(x => lin(x) + ' · ' + x.dias + ' días').join('\n') +
      '\n\nSi lo vas a usar, regístralo con una solicitud de material. Si no, almacén puede pasarlo a stock general para otras áreas.');
  });
  if (!a.vida.length && !a.dormidos.length) return 'Sin alertas.';
  const txt = (a.vida.length ? 'VENCIMIENTOS Y REVISIONES\n' + a.vida.map(x => lin(x) + ' · ' + x.estado + ' (' + x.fecha + ')').join('\n') + '\n\n' : '') +
              (a.dormidos.length ? 'MATERIAL SIN MOVIMIENTO (' + DIAS_DORMIDO + '+ días)\n' + a.dormidos.map(x => lin(x) + ' · ' + x.l.AREA + ' · ' + x.dias + ' días').join('\n') : '');
  enviarCorreo_(correos_(u => ['ADMIN', 'ALMACEN'].indexOf(U_(u.ROL)) >= 0), 'Almacén: vencimientos y material sin movimiento', txt);
  return 'Avisos enviados.';
}

/** Activa (o desactiva) el correo semanal de los lunes a las 7 a. m. Solo administrador. */
function activarAvisoSemanal(token, activar) {
  auth_(token, ['ADMIN']);
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'avisoSemanal').forEach(t => ScriptApp.deleteTrigger(t));
  if (activar) ScriptApp.newTrigger('avisoSemanal').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  return !!activar;
}

function avisoSemanalActivo_() {
  try { return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'avisoSemanal'); } catch (e) { return false; }
}


/* ---------------- Aviso: llegó material para solicitudes pendientes ---------------- */

/** Si el ingreso trae material de un REQ con solicitudes pendientes, avisa a almacén para completarlas. */
function avisarPendientes_(cab, items, doc) {
  if (U_(cab.tipo) !== 'INGRESO' || !U_(cab.req)) return;
  const req = U_(cab.req), cods = items.map(it => U_(it.codigo)), L = lotes_(leer_('MOVIMIENTOS'));
  const pend = solicitudes_().filter(x => CERRADOS.indexOf(U_(x.ESTADO)) < 0 && N_(x.CANT) > N_(x.ATENDIDO) &&
                                          cods.indexOf(U_(x.CODIGO)) >= 0 && solKey_(x, L) === 'REQ|' + req + '|' + U_(x.CODIGO));
  if (!pend.length) return;
  const porDoc = {}; pend.forEach(x => (porDoc[x.DOC] = porDoc[x.DOC] || []).push(x));
  enviarCorreo_(correos_(u => ESCRIBEN.indexOf(U_(u.ROL)) >= 0), 'Llegó material para solicitudes pendientes · ' + doc,
    'El ingreso ' + doc + ' (' + req + ') trae material que esperan estas solicitudes:\n\n' +
    Object.keys(porDoc).map(d => '  • ' + d + (porDoc[d][0].NRO_AREA ? ' (' + porDoc[d][0].NRO_AREA + ')' : '') + ' · ' + porDoc[d][0].AREA + ': ' +
      porDoc[d].map(x => x.DESCRIPCION + ' falta ' + (N_(x.CANT) - N_(x.ATENDIDO)) + ' ' + x.UND).join('; ')).join('\n') +
    '\n\nEntra al sistema para completarlas.');
}

/* ---------------- Lista maestra: eliminar un nombre sin uso ---------------- */

/** Borra un nombre que nunca se usó (0 movimientos, sin solicitudes ni usuarios). Los usados se desactivan o unifican. */
function eliminarEntidad(token, tipo, nombre) {
  auth_(token, ['ADMIN']);
  return conBloqueo_(() => {
    tipo = U_(tipo); nombre = U_(nombre);
    if (!TIPOS_ENTIDAD[tipo]) throw new Error('Tipo no válido.');
    const n = leer_('MOVIMIENTOS').filter(m => U_(m[TIPOS_ENTIDAD[tipo]]) === nombre).length;
    if (n) throw new Error(nombre + ' tiene ' + n + ' movimientos: no se puede eliminar. Desactívalo o unifícalo con el nombre correcto.');
    const colSol = { AREA: 'AREA', CONTRATISTA: 'RECEPTOR', OBRA: 'OBRA' }[tipo];
    if (colSol && solicitudes_().some(x => U_(x[colSol]) === nombre)) throw new Error(nombre + ' figura en solicitudes de material: no se puede eliminar. Desactívalo.');
    if (tipo === 'AREA' && leer_('USUARIOS').some(u => U_(u.AREA) === nombre)) throw new Error('Hay usuarios del área ' + nombre + ': cámbiales el área antes de eliminarla.');
    const sh = hoja_('ENTIDADES'), v = sh.getDataRange().getValues(), h = v[0].map(String);
    const i = v.findIndex((r, k) => k > 0 && U_(r[h.indexOf('TIPO')]) === tipo && U_(r[h.indexOf('NOMBRE')]) === nombre);
    if (i < 1) throw new Error('No se encontró ' + nombre + '.');
    sh.deleteRow(i + 1);
    return nombre;
  });
}

/* ---------------- Retazos ---------------- */

/** Unidades en que se mide un retazo sin balanza: metros (fierro, tubo, cable), piezas (planchas, madera) o pies (madera). */
const UND_RETAZO = ['M', 'PZA', 'PIE'];

/** Peso por metro de las varillas de fierro corrugado (tabla de fabricantes, ASTM A615). Sirve para pasar retazos a kg sin pesar. */
const KG_M_FIERRO = [[/1\s?3\/8/, 7.907], [/\b6\s?MM\b/, 0.222], [/\b8\s?MM\b/, 0.395], [/3\/8/, 0.56], [/\b12\s?MM\b/, 0.888],
                     [/1\/2/, 0.994], [/5\/8/, 1.552], [/3\/4/, 2.235], [/(^|[^\/\d])1\s?("|''|PULG)/, 3.973]];
function kgPorMetro_(desc) {
  const d = U_(desc);
  if (!/FIERRO|CORRUGAD|VARILLA/.test(d)) return 0;
  const r = KG_M_FIERRO.find(x => x[0].test(d));
  return r ? r[1] : 0;
}

/** Material "RETAZO …" del material dado en esa unidad; si no existe lo crea (mismo grupo, ubicación ZONA DE RETAZOS). */
function retazoDe_(mat, porCod, codigo, und) {
  const p = porCod[U_(codigo)];
  if (!p) throw new Error('El material ' + codigo + ' no existe en MATERIALES.');
  if (S_(p.RETAZO_DE)) return p;
  und = UND_RETAZO.indexOf(U_(und)) >= 0 ? U_(und) : 'M';
  let r = mat.find(m => U_(m.RETAZO_DE) === U_(p.CODIGO) && U_(m.UND) === und);
  if (r) return r;
  r = { CODIGO: nuevoCodigo_(mat, U_(p.CATEGORIA)), DESCRIPCION: 'RETAZO ' + U_(p.DESCRIPCION) + (und === 'M' ? '' : ' (' + und + ')'), CATEGORIA: U_(p.CATEGORIA),
        UND: und, STOCK_MIN: 0, UBICACION: 'ZONA DE RETAZOS', RETAZO_DE: p.CODIGO, KG_M: und === 'M' ? (kgPorMetro_(p.DESCRIPCION) || '') : '' };
  agregarFilas_('MATERIALES', [r]); mat.push(r); porCod[U_(r.CODIGO)] = r;
  return r;
}

/* ---------------- Corregir y anular documentos ---------------- */

const CAMPOS_CORREGIBLES = {
  INGRESO: ['FECHA', 'PROVEEDOR', 'AREA', 'OBRA', 'ORC', 'REQ', 'GUIA', 'OBS'],
  SALIDA: ['FECHA', 'CONTRATISTA', 'CONTRATO', 'AREA', 'OBRA', 'USO', 'SOLICITANTE', 'OBS'],
  PRESTAMO: ['FECHA', 'CONTRATISTA', 'CONTRATO', 'AREA', 'OBRA', 'AUTORIZA', 'SOLICITANTE', 'FECHA_DEV', 'OBS'],
  DEVOLUCION: ['FECHA', 'CONTRATISTA', 'CONTRATO', 'AREA', 'OBRA', 'OBS'],
  AJUSTE: ['FECHA', 'OBS'],
  INTERNAMIENTO: ['FECHA', 'CONTRATISTA', 'CONTRATO', 'OBRA', 'OBS'],
  MERMA: ['FECHA', 'CONTRATISTA', 'CONTRATO', 'OBRA', 'OBS']
};
const OBLIGATORIOS = { INGRESO: ['PROVEEDOR', 'AREA'], SALIDA: ['CONTRATISTA', 'AREA'], PRESTAMO: ['CONTRATISTA', 'AREA', 'FECHA_DEV'],
                       INTERNAMIENTO: ['CONTRATISTA'], AJUSTE: ['OBS'], MERMA: ['OBS'] };
const ETIQ_ENT = { PROVEEDOR: 'proveedores', CONTRATISTA: 'contratistas / receptores', AREA: 'áreas', OBRA: 'obras' };

/** El administrador corrige cualquier documento; el almacenero, solo los que registró hoy. */
function puedeCorregir_(ses, filas) {
  if (ses.rol === 'ADMIN') return;
  const hoy = hoy_();
  if (filas.some(x => S_(x.REGISTRADO).slice(0, 10) !== hoy))
    throw new Error('Este documento es de otro día: solo el administrador puede corregirlo. El almacenero corrige los que se registraron hoy.');
}

/** Rechaza el cambio si deja stock, una orden o un préstamo en negativo (salvo que ya lo estuviera antes). */
function validarCambio_(mat, antes, despues) {
  const s0 = {};
  calcularStock_(mat, antes).forEach(s => s0[U_(s.CODIGO)] = s.SALDO);
  calcularStock_(mat, despues).forEach(s => {
    if (s.SALDO < -1e-9 && s.SALDO < N_(s0[U_(s.CODIGO)]) - 1e-9)
      throw new Error('Con este cambio el stock de ' + s.DESCRIPCION + ' quedaría en ' + s.SALDO + ' ' + s.UND + ': ya salió más de lo que quedaría. Revisa primero esas salidas.');
  });
  const L0 = lotes_(antes), L1 = lotes_(despues);
  Object.keys(L1).forEach(id => {
    const l = L1[id], b = L0[id] ? L0[id].SALDO : 0;
    if (l.SALDO < -1e-9 && l.SALDO < b - 1e-9)
      throw new Error('La orden ' + (l.ORC || l.DOC) + ' de ' + l.DESCRIPCION + ' quedaría con saldo ' + l.SALDO + ' ' + l.UND + ': ya salió más de eso.');
  });
  const p = {}, k = (d, x) => U_(d) + '|' + U_(x.CODIGO) + '|' + S_(x.LOTE);
  despues.filter(vivo_).forEach(x => { if (U_(x.TIPO) === 'PRESTAMO') p[k(x.DOC, x)] = (p[k(x.DOC, x)] || 0) + N_(x.CANT); });
  despues.filter(vivo_).forEach(x => { if (U_(x.TIPO) === 'DEVOLUCION' && S_(x.DOC_REF)) p[k(x.DOC_REF, x)] = (p[k(x.DOC_REF, x)] || 0) - N_(x.CANT); });
  Object.keys(p).forEach(c => { if (p[c] < -1e-9) throw new Error('El préstamo ' + c.split('|')[0] + ' quedaría con más devuelto que prestado.'); });
}

/**
 * Cambios que un vale corregido o anulado hace en las solicitudes que atendió: lo entregado sube o baja y el estado se recalcula.
 * delta = {codigo: diferencia}. Solo calcula y valida; devuelve [{fila, cambios}] para escribir después.
 */
function planSolicitudes_(doc, delta, anula) {
  const sh = hojaAuto_('SOLICITUDES'); asegurarEncabezados_(sh, 'SOLICITUDES');
  const v = sh.getDataRange().getValues(), h = v[0].map(x => String(x).trim()), c = n => h.indexOf(n), plan = [];
  const filas = []; for (let r = 1; r < v.length; r++) if (S_(v[r][c('DOC_SAL')]).split(/\s+/).indexOf(U_(doc)) >= 0) filas.push(r);
  Object.keys(delta).forEach(cod => {
    const dq = delta[cod]; if (!dq && !anula) return;
    const r = filas.find(i => U_(v[i][c('CODIGO')]) === U_(cod)); if (r == null) return;
    const cant = N_(v[r][c('CANT')]), att = Math.max(0, N_(v[r][c('ATENDIDO')]) + dq), est = U_(v[r][c('ESTADO')]);
    if (att > cant + 1e-9) throw new Error('La solicitud ' + v[r][c('DOC')] + ' pidió ' + cant + ' de ' + v[r][c('DESCRIPCION')] + ': con este cambio se entregaría ' + att + '.');
    const cb = { ATENDIDO: att };
    if ([EST_SOL.ENVIADA, EST_SOL.VISTA, EST_SOL.APROBADA, EST_SOL.PARCIAL, EST_SOL.ENTREGADA].indexOf(est) >= 0) {
      cb.ESTADO = att + 1e-9 >= cant ? EST_SOL.ENTREGADA : att > 0 ? EST_SOL.PARCIAL : (S_(v[r][c('APROBADA_EN')]) ? EST_SOL.APROBADA : EST_SOL.VISTA);
      if (cb.ESTADO !== EST_SOL.ENTREGADA && est === EST_SOL.ENTREGADA) { cb.CERRADA_POR = ''; cb.CERRADA_EN = ''; }
    }
    if (anula) cb.DOC_SAL = S_(v[r][c('DOC_SAL')]).split(/\s+/).filter(x => x && x !== U_(doc)).join(' ');
    plan.push({ fila: r, cambios: cb });
  });
  return { sh: sh, head: h, plan: plan };
}
function aplicarPlan_(p) {
  p.plan.forEach(x => Object.keys(x.cambios).forEach(k => { const j = p.head.indexOf(k); if (j >= 0) p.sh.getRange(x.fila + 1, j + 1).setValue(x.cambios[k]); }));
}

/** Escribe en MOVIMIENTOS los cambios {ID: {COLUMNA: valor}} y deja el registro en CORRECCIONES. */
function escribirCorreccion_(ses, doc, set, log, motivo, marca) {
  const sh = hoja_('MOVIMIENTOS'); asegurarEncabezados_(sh, 'MOVIMIENTOS');
  const v = sh.getDataRange().getValues(), head = v[0].map(x => String(x).trim()), iId = head.indexOf('ID'), iDoc = head.indexOf('DOC');
  for (let r = 1; r < v.length; r++) {
    const id = N_(v[r][iId]), cambios = Object.assign({}, set[id] || {});
    if (U_(v[r][iDoc]) === U_(doc)) Object.assign(cambios, marca);
    Object.keys(cambios).forEach(k => {
      const j = head.indexOf(k); if (j < 0) return;
      const cell = sh.getRange(r + 1, j + 1);
      if ((TEXTO.MOVIMIENTOS || []).indexOf(k) >= 0) cell.setNumberFormat('@');
      cell.setValue((k === 'FECHA' || k === 'FECHA_DEV') && /^\d{4}-\d{2}-\d{2}$/.test(S_(cambios[k])) ? fecha_(S_(cambios[k])) : cambios[k]);
    });
  }
  hojaAuto_('CORRECCIONES');
  const f = new Date();
  agregarFilas_('CORRECCIONES', log.map(x => ({ FECHA: f, USUARIO: ses.usuario, DOC: U_(doc), ID: x.ID, CAMPO: x.CAMPO, ANTES: x.ANTES, AHORA: x.AHORA, MOTIVO: motivo })));
}

/**
 * Corrige un documento ya registrado. cambios = {cab: {CAMPO: valor}, lineas: [{id, cant, codigo}]}; motivo obligatorio.
 * Cabecera: siempre. Cantidad: si ningún saldo queda negativo. Material: solo en ingresos cuya orden no tuvo movimientos.
 * Si se corrige el REQ o la ORC de un ingreso, el cambio pasa a las salidas de esa orden. Un vale que atendió una solicitud la actualiza.
 */
function corregirDocumento(token, doc, cambios, motivo) {
  const ses = auth_(token, ESCRIBEN);
  return conBloqueo_(() => {
    const mot = S_(motivo); if (!mot) throw new Error('Escribe el motivo de la corrección.');
    doc = U_(doc);
    const movT = leer_('MOVIMIENTOS'), antes = movT.map(x => Object.assign({}, x)), filas = movT.filter(x => U_(x.DOC) === doc);
    if (!filas.length) throw new Error('No se encontró el documento ' + doc + '.');
    if (!vivo_(filas[0])) throw new Error('El documento ' + doc + ' está anulado.');
    const tipo = U_(filas[0].TIPO), campos = CAMPOS_CORREGIBLES[tipo];
    if (!campos) throw new Error('Un pase a stock general no se corrige: el administrador puede anularlo y registrarlo de nuevo.');
    puedeCorregir_(ses, filas);
    const cab = (cambios && cambios.cab) || {}, lin = (cambios && cambios.lineas) || [];
    const ent = leer_('ENTIDADES'), mat = leer_('MATERIALES'), porCod = {}; mat.forEach(m => porCod[U_(m.CODIGO)] = m);
    const set = {}, log = [], delta = {};
    const poner = (x, col, val, registrar) => {
      if (S_(x[col]) === S_(val)) return;
      (set[N_(x.ID)] = set[N_(x.ID)] || {})[col] = val;
      if (registrar !== false) log.push({ ID: N_(x.ID), CAMPO: col, ANTES: S_(x[col]), AHORA: S_(val) });
      x[col] = val;
    };

    // cabecera
    const ingAntes = { REQ: S_(filas[0].REQ), ORC: S_(filas[0].ORC) }, contAntes = U_(filas[0].CONTRATO);
    Object.keys(cab).forEach(k => {
      const col = U_(k); let val = cab[k];
      if (campos.indexOf(col) < 0) throw new Error('El campo ' + col + ' no se corrige en este documento.');
      const oblig = (OBLIGATORIOS[tipo] || []).indexOf(col) >= 0;
      if (ETIQ_ENT[col]) val = entidad_(ent, col, val, oblig, ETIQ_ENT[col]);
      else if (col === 'FECHA' || col === 'FECHA_DEV') { val = S_(val); if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) throw new Error('Fecha no válida.'); }
      else if (col === 'OBS' || col === 'ORC') val = S_(val);
      else if (col === 'CONTRATO') val = contrato_(val);
      else val = U_(val);
      if (oblig && !S_(val)) throw new Error('El campo ' + col + ' no puede quedar vacío.');
      filas.forEach(x => poner(x, col, val));
    });
    if (tipo === 'PRESTAMO' && U_(filas[0].CONTRATO) !== contAntes)   // sus devoluciones que heredaron el contrato se corrigen igual
      movT.filter(x => U_(x.TIPO) === 'DEVOLUCION' && U_(x.DOC_REF) === doc && U_(x.CONTRATO) === contAntes).forEach(x => poner(x, 'CONTRATO', filas[0].CONTRATO));
    if (tipo === 'PRESTAMO' && S_(filas[0].FECHA_DEV) < S_(filas[0].FECHA)) throw new Error('La fecha de devolución no puede ser anterior a la del préstamo.');
    if (tipo === 'INGRESO' && (S_(filas[0].REQ) !== ingAntes.REQ || S_(filas[0].ORC) !== ingAntes.ORC)) {
      // las salidas de estas órdenes llevan el REQ y la ORC de la orden: se corrigen igual
      const ids = filas.map(x => S_(x.LOTE) || S_(x.ID));
      movT.filter(x => U_(x.DOC) !== doc && U_(x.TIPO) !== 'INGRESO' && ids.indexOf(S_(x.LOTE)) >= 0).forEach(x => {
        poner(x, 'REQ', filas[0].REQ); poner(x, 'ORC', filas[0].ORC);
      });
    }

    // líneas
    lin.forEach(c => {
      const x = filas.find(z => N_(z.ID) === N_(c.id)); if (!x) throw new Error('Esa línea no pertenece al documento ' + doc + '.');
      if (c.codigo != null && S_(c.codigo) && U_(c.codigo) !== U_(x.CODIGO)) {
        if (tipo !== 'INGRESO') throw new Error('El material solo se cambia en un ingreso. En otros documentos, anúlalo y regístralo de nuevo.');
        const m = porCod[U_(c.codigo)]; if (!m) throw new Error('El material ' + c.codigo + ' no existe.');
        const lid = S_(x.LOTE) || S_(x.ID);
        if (movT.some(z => U_(z.DOC) !== doc && vivo_(z) && (S_(z.LOTE) === lid || S_(z.LOTE_ORIGEN) === lid)))
          throw new Error('No se puede cambiar el material de ' + x.DESCRIPCION + ': esa orden ya tuvo salidas u otros movimientos.');
        delta[U_(x.CODIGO)] = 0;
        poner(x, 'CODIGO', m.CODIGO); poner(x, 'DESCRIPCION', m.DESCRIPCION, false); poner(x, 'UND', m.UND, false);
      }
      if (c.cant != null && S_(c.cant) !== '' && Number(c.cant) !== N_(x.CANT)) {
        if (tipo === 'AJUSTE') throw new Error('Un ajuste no se corrige por cantidad: registra otro ajuste con el conteo correcto.');
        const q = Number(c.cant);
        if (!(q > 0)) throw new Error('Cantidad no válida en ' + x.DESCRIPCION + '. Si no salió nada, anula el documento.');
        if (entera_(x.UND) && Math.abs(q - Math.round(q)) > 1e-9) throw new Error(x.DESCRIPCION + ' se cuenta en ' + U_(x.UND) + ' enteras.');
        delta[U_(x.CODIGO)] = (delta[U_(x.CODIGO)] || 0) + q - N_(x.CANT);
        poner(x, 'CANT', q);
        if (N_(x.FACTOR) > 0) { const cc = Math.round(q / N_(x.FACTOR) * 1e6) / 1e6; poner(x, 'CANT_COMPRA', cc, false); poner(x, 'TOTAL', Math.round(cc * N_(x.PU_COMPRA) * 100) / 100, false); }
        else poner(x, 'TOTAL', Math.round(q * N_(x.PU) * 100) / 100, false);
      }
    });
    if (!log.length) throw new Error('No hay cambios que guardar.');
    validarCambio_(mat, antes, movT);
    const ps = tipo === 'SALIDA' ? planSolicitudes_(doc, delta, false) : null;

    escribirCorreccion_(ses, doc, set, log, mot, { CORREGIDO: ahora_() + ' por ' + ses.nombre });
    if (ps) aplicarPlan_(ps);
    recalcular();
    return log.length;
  });
}

/** Anula un documento hecho por error (solo administrador). Queda visible como ANULADO y deja de contar. */
function anularDocumento(token, doc, motivo) {
  const ses = auth_(token, ['ADMIN']);
  return conBloqueo_(() => {
    const mot = S_(motivo); if (!mot) throw new Error('Escribe por qué se anula.');
    doc = U_(doc);
    const movT = leer_('MOVIMIENTOS'), antes = movT.map(x => Object.assign({}, x)), filas = movT.filter(x => U_(x.DOC) === doc);
    if (!filas.length) throw new Error('No se encontró el documento ' + doc + '.');
    if (!vivo_(filas[0])) throw new Error('El documento ' + doc + ' ya está anulado.');
    const tipo = U_(filas[0].TIPO);
    // las órdenes que nacen de este documento no deben tener movimientos
    const ids = tipo === 'INGRESO' ? filas.map(x => S_(x.LOTE) || S_(x.ID)) : tipo === 'INTERNAMIENTO' ? filas.map(x => S_(x.LOTE)).filter(Boolean) : tipo === 'LIBERACION' ? filas.map(x => S_(x.ID)) : [];
    const usa = movT.find(z => U_(z.DOC) !== doc && vivo_(z) && (ids.indexOf(S_(z.LOTE)) >= 0 || ids.indexOf(S_(z.LOTE_ORIGEN)) >= 0));
    if (usa) throw new Error('No se puede anular ' + doc + ': el documento ' + usa.DOC + ' ya usó su material. Anula o corrige primero ' + usa.DOC + '.');
    if (tipo === 'PRESTAMO') { const dv = movT.find(z => vivo_(z) && U_(z.DOC_REF) === doc); if (dv) throw new Error('El préstamo ' + doc + ' ya tiene la devolución ' + dv.DOC + ': anúlala primero.'); }
    const marca = ahora_() + ' por ' + ses.nombre + ': ' + mot;
    filas.forEach(x => x.ANULADO = marca);
    validarCambio_(leer_('MATERIALES'), antes, movT);
    const delta = {}; filas.forEach(x => delta[U_(x.CODIGO)] = (delta[U_(x.CODIGO)] || 0) - N_(x.CANT));
    const ps = tipo === 'SALIDA' ? planSolicitudes_(doc, delta, true) : null;
    escribirCorreccion_(ses, doc, {}, [{ ID: '', CAMPO: 'ANULADO', ANTES: '', AHORA: 'ANULADO' }], mot, { ANULADO: marca });
    if (ps) aplicarPlan_(ps);
    recalcular();
    return true;
  });
}


/* ---------------- Cierre anual ---------------- */

/** Numeración que sigue después de un cierre (los documentos viejos ya no están en la hoja). */
function numBase_(pre) {
  try { return N_(PropertiesService.getScriptProperties().getProperty('NUM_' + pre)); } catch (e) { return 0; }
}
function ultimoCierre_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('CIERRE_ULTIMO') || 'null'); } catch (e) { return null; }
}

/**
 * Arma lo que queda en el archivo después del cierre:
 *  - una línea de saldo inicial por cada orden con saldo (misma orden, REQ, área, precio y fecha de ingreso),
 *  - los préstamos con algo pendiente (solo lo que falta devolver),
 *  - las solicitudes que siguen abiertas.
 */
function planCierre_(corte) {
  const mat = leer_('MATERIALES'), movT = leer_('MOVIMIENTOS'), mov = ordenar_(movT.filter(vivo_)), L = lotes_(mov);
  const porCod = {}; mat.forEach(m => porCod[U_(m.CODIGO)] = m);
  const sol = solicitudes_(), abiertas = {};
  sol.forEach(x => { if (CERRADOS.indexOf(U_(x.ESTADO)) < 0) abiertas[x.DOC] = 1; });
  const solKeep = sol.filter(x => abiertas[x.DOC]), lotRef = {};
  solKeep.forEach(x => { if (S_(x.LOTE)) lotRef[S_(x.LOTE)] = 1; });
  // préstamos pendientes: por documento, material y orden
  const P = {}, k = (d, x) => U_(d) + '|' + U_(x.CODIGO) + '|' + S_(x.LOTE);
  mov.forEach(x => { if (U_(x.TIPO) === 'PRESTAMO') { const c = k(x.DOC, x); (P[c] = P[c] || { x: x, q: 0 }).q += N_(x.CANT); } });
  mov.forEach(x => { if (U_(x.TIPO) === 'DEVOLUCION' && S_(x.DOC_REF)) { const c = k(x.DOC_REF, x); if (P[c]) P[c].q -= N_(x.CANT); } });
  const pend = Object.values(P).filter(p => p.q > 1e-9), pendLote = {};
  pend.forEach(p => { const l = S_(p.x.LOTE); if (l) pendLote[l] = (pendLote[l] || 0) + p.q; });

  const r6 = n => Math.round(n * 1e6) / 1e6, r2 = n => Math.round(n * 100) / 100;
  let id = movT.reduce((a, x) => Math.max(a, N_(x.ID)), 0);
  const doc = 'SI-' + corte.slice(0, 4), ahora = new Date(), filas = [];
  const base = { DOC: doc, TIPO: 'INGRESO', USUARIO: 'CIERRE ANUAL', REGISTRADO: ahora };
  // cada orden con saldo (o pedida por una solicitud abierta) vuelve a entrar con su mismo número de orden
  Object.values(L).sort(porFecha_).forEach(l => {
    const q = r6(l.SALDO + (pendLote[l.ID] || 0));
    if (q < -1e-9 || (q < 1e-9 && !lotRef[l.ID])) return;
    filas.push(Object.assign({}, base, { ID: ++id, FECHA: S_(l.FECHA).slice(0, 10), CODIGO: l.CODIGO, DESCRIPCION: l.DESCRIPCION, UND: l.UND,
      CANT: q, PU: N_(l.PU), TOTAL: r2(q * N_(l.PU)), PROVEEDOR: l.PROVEEDOR || '', ORC: S_(l.ORC), REQ: S_(l.REQ), AREA: U_(l.AREA), LOTE: l.ID,
      VENCE: S_(l.VENCE), ULT_MOV: S_(l.ULT).slice(0, 10), OBS: 'Saldo inicial al ' + fechaTxt_(corte) + ' (ingresó con ' + l.DOC + ')' }));
  });
  // préstamos sin devolver: queda solo lo pendiente, con su fecha y su fecha de devolución
  pend.forEach(p => filas.push(Object.assign({}, p.x, { ID: ++id, CANT: r6(p.q), TOTAL: r2(p.q * N_(p.x.PU)), ANULADO: '', CORREGIDO: '', ULT_MOV: '',
    OBS: (S_(p.x.OBS) ? S_(p.x.OBS) + ' · ' : '') + 'Pendiente que pasa del cierre al ' + fechaTxt_(corte) })));
  // lo que no estaba en ninguna orden (stock antiguo sin orden) se cuadra contra el stock por material
  const antes = calcularStock_(mat, mov), despues = {};
  calcularStock_(mat, filas).forEach(s => despues[U_(s.CODIGO)] = s.SALDO);
  antes.forEach(s => {
    const d = r6(s.SALDO - (despues[U_(s.CODIGO)] || 0)); if (Math.abs(d) < 1e-9) return;
    const nid = ++id;
    filas.push(Object.assign({}, base, { ID: nid, DOC: d > 0 ? doc : doc + '-AJ', TIPO: d > 0 ? 'INGRESO' : 'AJUSTE', FECHA: corte, CODIGO: s.CODIGO,
      DESCRIPCION: s.DESCRIPCION, UND: s.UND, CANT: d, PU: s.COSTO_PROM, TOTAL: r2(d * s.COSTO_PROM), PROVEEDOR: d > 0 ? 'SALDO INICIAL' : '',
      LOTE: d > 0 ? String(nid) : '', OBS: 'Saldo inicial al ' + fechaTxt_(corte) + ' sin orden de compra' }));
  });
  return { filas: filas, solKeep: solKeep, antes: movT.length, saldos: filas.filter(x => x.DOC === doc).length, prestamos: pend.length,
           solAbiertas: Object.keys(abiertas).length, solCerradas: uniq_(sol.map(x => x.DOC)).length - Object.keys(abiertas).length, doc: doc };
}
const uniq_ = a => a.filter((x, i) => a.indexOf(x) === i);

/** Lo que haría el cierre, para mostrarlo antes de confirmar. */
function resumenCierre(token, corte) {
  auth_(token, ['ADMIN']);
  corte = /^\d{4}-\d{2}-\d{2}$/.test(S_(corte)) ? S_(corte) : hoy_();
  const p = planCierre_(corte);
  return { movimientos: p.antes, saldos: p.saldos, prestamos: p.prestamos, solAbiertas: p.solAbiertas, solCerradas: p.solCerradas, doc: p.doc, ultimo: ultimoCierre_() };
}

/** Reemplaza el contenido de una hoja (deja el encabezado). */
function reescribir_(nombre, objetos) {
  const sh = hoja_(nombre); asegurarEncabezados_(sh, nombre);
  const n = sh.getLastRow(); if (n > 1) sh.getRange(2, 1, n - 1, Math.max(1, sh.getLastColumn())).clearContent();
  if (objetos.length) agregarFilas_(nombre, objetos);
}

/**
 * Cierre anual (solo administrador): guarda una copia completa del archivo en Drive y deja en este archivo
 * solo los saldos iniciales por orden, los préstamos pendientes y las solicitudes abiertas.
 * Usuarios, materiales, equivalencias y la lista maestra no cambian. La numeración de documentos continúa.
 */
function cierreAnual(token, corte, confirma) {
  const ses = auth_(token, ['ADMIN']);
  if (U_(confirma) !== 'CERRAR') throw new Error('Escribe CERRAR para confirmar el cierre.');
  corte = S_(corte) || hoy_();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(corte)) throw new Error('Fecha de cierre no válida.');
  return conBloqueo_(() => {
    const ss = SpreadsheetApp.getActive(), p = planCierre_(corte);
    if (leer_('MOVIMIENTOS').some(x => U_(x.DOC) === p.doc)) throw new Error('Ya se hizo un cierre con saldo inicial ' + p.doc + '. Elige otra fecha de cierre.');
    // 1. copia de respaldo con todo el historial
    const copia = ss.copy(ss.getName() + ' - histórico al ' + fechaTxt_(corte));
    // 2. la numeración sigue desde el último documento (no se repiten números)
    const props = PropertiesService.getScriptProperties(), nums = {};
    leer_('MOVIMIENTOS').concat(solicitudes_()).forEach(x => { const m = /^([A-Z]+)-(\d+)$/.exec(S_(x.DOC)); if (m) nums[m[1]] = Math.max(nums[m[1]] || 0, +m[2]); });
    Object.keys(nums).forEach(k => props.setProperty('NUM_' + k, String(Math.max(nums[k], numBase_(k)))));
    // 3. saldos iniciales y pendientes
    const fechas = o => { ['FECHA', 'FECHA_DEV'].forEach(c => { if (/^\d{4}-\d{2}-\d{2}$/.test(S_(o[c]))) o[c] = fecha_(S_(o[c])); }); return o; };
    reescribir_('MOVIMIENTOS', p.filas.map(fechas));
    reescribir_('SOLICITUDES', p.solKeep.map(fechas));
    reescribir_('CORRECCIONES', []);
    const info = { fecha: corte, por: ses.nombre, en: ahora_(), url: copia.getUrl(), nombre: copia.getName(), doc: p.doc };
    props.setProperty('CIERRE_ULTIMO', JSON.stringify(info));
    recalcular();
    return Object.assign(info, { movimientos: p.antes, saldos: p.saldos, prestamos: p.prestamos, solAbiertas: p.solAbiertas, solCerradas: p.solCerradas });
  });
}

/* ---------------- Copia de seguridad semanal ---------------- */

const RESPALDO_CARPETA = 'Respaldos Control Almacén';
const RESPALDOS_GUARDADOS = 8;   // se conservan las últimas 8 copias (2 meses); las más antiguas van a la papelera

/** Carpeta de respaldos: al lado de la hoja (se crea sola la primera vez). */
function carpetaRespaldo_() {
  const props = PropertiesService.getScriptProperties(), id = props.getProperty('RESPALDO_CARPETA');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* la borraron: se crea otra */ } }
  const hoja = DriveApp.getFileById(SpreadsheetApp.getActive().getId()), padres = hoja.getParents();
  const padre = padres.hasNext() ? padres.next() : DriveApp.getRootFolder();
  const ya = padre.getFoldersByName(RESPALDO_CARPETA), f = ya.hasNext() ? ya.next() : padre.createFolder(RESPALDO_CARPETA);
  props.setProperty('RESPALDO_CARPETA', f.getId());
  return f;
}

/** Hace una copia completa del archivo (todas las hojas) en la carpeta de respaldos. La ejecuta el disparador de los domingos. */
function respaldoSemanal() {
  const ss = SpreadsheetApp.getActive(), carpeta = carpetaRespaldo_();
  const nombre = ss.getName() + ' - respaldo ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH.mm');
  const copia = DriveApp.getFileById(ss.getId()).makeCopy(nombre, carpeta);
  const prefijo = ss.getName() + ' - respaldo ', copias = [], it = carpeta.getFiles();
  while (it.hasNext()) { const f = it.next(); if (f.getName().indexOf(prefijo) === 0) copias.push(f); }
  copias.sort((a, b) => b.getDateCreated() - a.getDateCreated()).slice(RESPALDOS_GUARDADOS).forEach(f => f.setTrashed(true));
  const info = { en: ahora_(), nombre: nombre, url: copia.getUrl(), carpeta: carpeta.getUrl(), copias: Math.min(copias.length, RESPALDOS_GUARDADOS) };
  PropertiesService.getScriptProperties().setProperty('RESPALDO_ULTIMO', JSON.stringify(info));
  return info;
}

function respaldoInfo_() {
  let ult = null;
  try { ult = JSON.parse(PropertiesService.getScriptProperties().getProperty('RESPALDO_ULTIMO') || 'null'); } catch (e) { ult = null; }
  let activo = false;
  try { activo = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'respaldoSemanal'); } catch (e) { activo = false; }
  return { activo: activo, ultimo: ult, guardadas: RESPALDOS_GUARDADOS };
}

/** Activa (o desactiva) la copia de los domingos a las 10 p. m. Solo administrador. */
function activarRespaldo(token, activar) {
  auth_(token, ['ADMIN']);
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'respaldoSemanal').forEach(t => ScriptApp.deleteTrigger(t));
  if (!activar) return respaldoInfo_();
  copiar_();   // la primera copia se hace al activar: así se comprueba el permiso de Drive
  ScriptApp.newTrigger('respaldoSemanal').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(22).create();
  return respaldoInfo_();
}

function copiar_() {
  try { return respaldoSemanal(); }
  catch (e) { throw new Error('No se pudo copiar el archivo. Ejecuta una vez "Dar permisos" en el menú Almacén (ahora pide acceso a Drive) y vuelve a intentarlo. Detalle: ' + (e.message || e)); }
}

/** Copia inmediata (botón "Hacer una copia ahora"). */
function respaldarAhora(token) {
  auth_(token, ['ADMIN']);
  copiar_();
  return respaldoInfo_();
}

/* ---------------- Unidades de medida (lista fija con código SUNAT) ---------------- */

/**
 * Lista base: nombre que se ve en almacén, código del Catálogo N° 03 de SUNAT (unidades de medida comercial)
 * y sinónimos = formas en que la gente lo escribe (no son oficiales; el sistema los cambia al nombre).
 * Lo que SUNAT no distingue (plancha, varilla, tubo…) va como unidad: NIU.
 */
const UNIDADES_BASE = [
  ['UND', 'NIU', 'UNID, UNIDAD, UNIDADES, U, UN, UNI'],
  ['PZA', 'NIU', 'PIEZA, PIEZAS, PZ, PZAS'],
  ['GALON', 'GLL', 'GL, GAL, GLN, GLNS, GALONES'],
  ['LITRO', 'LTR', 'L, LT, LTS, LITROS'],
  ['KG', 'KGM', 'KGS, KILO, KILOS, KILOGRAMO, KILOGRAMOS, KLG'],
  ['GR', 'GRM', 'G, GRS, GRAMO, GRAMOS'],
  ['TN', 'TNE', 'TON, TONELADA, TONELADAS, TM'],
  ['M', 'MTR', 'ML, MT, MTS, METRO, METROS, METRO LINEAL'],
  ['M2', 'MTK', 'MT2, MTS2, M², METRO CUADRADO, METROS CUADRADOS'],
  ['M3', 'MTQ', 'MT3, MTS3, M³, METRO CUBICO, METROS CUBICOS'],
  ['PIE', 'FOT', 'PIES, FT'],
  ['BOLSA', 'BG', 'BOLSAS, BLS, BL'],
  ['CAJA', 'BX', 'CAJAS, CJ, CJA'],
  ['PQT', 'PK', 'PAQ, PAQUETE, PAQUETES, PQ, PQTE'],
  ['ROLLO', 'RO', 'ROLLOS, RLL, RL'],
  ['BALDE', 'BJ', 'BALDES, BDE'],
  ['LATA', 'CA', 'LATAS'],
  ['PAR', 'PR', 'PARES'],
  ['JUEGO', 'SET', 'JGO, JUEGOS, KIT'],
  ['PLANCHA', 'NIU', 'PLANCHAS, PLA'],
  ['VARILLA', 'NIU', 'VARILLAS, VAR'],
  ['TUBO', 'NIU', 'TUBOS'],
  ['CARTUCHO', 'NIU', 'CARTUCHOS, CART']
];
const sinTildesU_ = s => U_(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\.$/, '').replace(/\s+/g, ' ');

/** Lee la hoja UNIDADES (la crea y la llena con la lista base la primera vez). */
function unidades_() {
  const sh = hojaAuto_('UNIDADES');
  let l = leer_('UNIDADES');
  if (!l.length) {
    agregarFilas_('UNIDADES', UNIDADES_BASE.map(u => ({ NOMBRE: u[0], CODIGO_SUNAT: u[1], SINONIMOS: u[2], ACTIVO: 'SI' })));
    l = leer_('UNIDADES');
  }
  return l.map(u => ({ NOMBRE: U_(u.NOMBRE), CODIGO_SUNAT: U_(u.CODIGO_SUNAT), SINONIMOS: S_(u.SINONIMOS), ACTIVO: U_(u.ACTIVO) || 'SI' })).filter(u => u.NOMBRE);
}

/** Mapa de cualquier forma escrita → nombre oficial. */
function mapaUnd_(lista) {
  const m = {};
  (lista || unidades_()).forEach(u => { m[sinTildesU_(u.NOMBRE)] = u.NOMBRE;
    S_(u.SINONIMOS).split(/[,;]/).map(sinTildesU_).filter(Boolean).forEach(x => { if (!m[x]) m[x] = u.NOMBRE; }); });
  return m;
}
let MAPA_UND_ = null;
function canonUnd_(und) {
  const k = sinTildesU_(und); if (!k) return '';
  if (!MAPA_UND_) { try { MAPA_UND_ = mapaUnd_(); } catch (e) { MAPA_UND_ = {}; } }
  return MAPA_UND_[k] || U_(und);
}

/** Crea o corrige una unidad (solo administrador). d = {nombre, antes, codigo, sinonimos, activo} */
function guardarUnidad(token, d) {
  auth_(token, ['ADMIN']);
  return conBloqueo_(() => {
    const nombre = U_(d.nombre), antes = U_(d.antes), cod = U_(d.codigo).replace(/\s/g, '');
    if (!nombre) throw new Error('Escribe el nombre de la unidad.');
    if (nombre.length > 10) throw new Error('El nombre de la unidad debe tener 10 letras como máximo.');
    if (!cod) throw new Error('Escribe el código SUNAT (Catálogo N° 03). Si no tiene uno propio, usa NIU (unidad).');
    const lista = unidades_(), sin = uniq_(S_(d.sinonimos).split(/[,;]/).map(sinTildesU_).filter(x => x && x !== sinTildesU_(nombre)));
    const otras = lista.filter(u => u.NOMBRE !== (antes || nombre)), mapa = mapaUnd_(otras);
    if (!antes && lista.some(u => u.NOMBRE === nombre)) throw new Error('La unidad ' + nombre + ' ya existe.');
    if (antes && antes !== nombre && lista.some(u => u.NOMBRE === nombre)) throw new Error('La unidad ' + nombre + ' ya existe.');
    if (mapa[sinTildesU_(nombre)]) throw new Error(nombre + ' ya es sinónimo de ' + mapa[sinTildesU_(nombre)] + '.');
    const choca = sin.filter(x => mapa[x]);
    if (choca.length) throw new Error('Estos sinónimos ya son de otra unidad: ' + choca.map(x => x + ' (' + mapa[x] + ')').join(', ') + '.');
    const fila = { NOMBRE: nombre, CODIGO_SUNAT: cod, SINONIMOS: sin.join(', '), ACTIVO: d.activo === false || U_(d.activo) === 'NO' ? 'NO' : 'SI' };
    if (antes) {
      const i = lista.findIndex(u => u.NOMBRE === antes); if (i < 0) throw new Error('No se encontró la unidad ' + antes + '.');
      if (antes !== nombre && leer_('MATERIALES').some(m => U_(m.UND) === antes))
        throw new Error('No se puede renombrar ' + antes + ': ya hay materiales con esa unidad. Agrega ' + nombre + ' como sinónimo o usa "Unificar unidades".');
      lista[i] = fila; reescribir_('UNIDADES', lista);
    } else agregarFilas_('UNIDADES', [fila]);
    MAPA_UND_ = null;
    return nombre;
  });
}

/** Cambia en una columna de una hoja los valores que fn devuelva distintos (solo esa columna; fechas y demás no se tocan). */
function cambiarColumna_(nombre, col, fn, aplicar) {
  const sh = SpreadsheetApp.getActive().getSheetByName(nombre); if (!sh || sh.getLastRow() < 2) return 0;
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim()), c = head.indexOf(col);
  if (c < 0) return 0;
  const r = sh.getRange(2, c + 1, sh.getLastRow() - 1, 1), v = r.getValues(); let n = 0;
  const nv = v.map(f => { const a = f[0]; if (a === '' || a == null) return [a]; const b = fn(a); if (String(b) !== String(a)) { n++; return [b]; } return [a]; });
  if (n && aplicar) r.setValues(nv);
  return n;
}

/** Plan para pasar las unidades escritas distinto (GL, BLS, KGS…) a su nombre oficial. */
function planUnificar_(aplicar) {
  const lista = unidades_(), mapa = mapaUnd_(lista), oficiales = {};
  lista.forEach(u => oficiales[u.NOMBRE] = 1);
  const can = v => { const k = sinTildesU_(v); return mapa[k] || U_(v); };
  const cambios = {}, fuera = {};
  const nota = v => { const a = U_(v), b = can(v); if (a && a !== b) cambios[a + ' → ' + b] = (cambios[a + ' → ' + b] || 0) + 1; else if (a && !oficiales[a]) fuera[a] = (fuera[a] || 0) + 1; return b; };
  leer_('MATERIALES').forEach(m => nota(m.UND));
  hojaAuto_('EQUIVALENCIAS');
  // equivalencias: se renombra la unidad de compra; si queda igual a la unidad del material o repetida, se quita
  const mat = {}; leer_('MATERIALES').forEach(m => mat[U_(m.CODIGO)] = can(m.UND));
  const eq = leer_('EQUIVALENCIAS'), visto = {}, quedan = [], quitadas = []; let renombradas = 0;
  eq.forEach(e => { const u = can(e.UND_COMPRA), k = U_(e.CODIGO) + '|' + u;
    if (u === mat[U_(e.CODIGO)] || visto[k]) { quitadas.push(U_(e.CODIGO) + ': 1 ' + U_(e.UND_COMPRA) + ' = ' + e.FACTOR + (u === mat[U_(e.CODIGO)] ? ' (ya es su unidad)' : ' (repetida)')); return; }
    visto[k] = 1; if (U_(e.UND_COMPRA) !== u) { nota(e.UND_COMPRA); renombradas++; } quedan.push(Object.assign({}, e, { UND_COMPRA: u })); });
  const n = { materiales: cambiarColumna_('MATERIALES', 'UND', can, aplicar), movimientos: cambiarColumna_('MOVIMIENTOS', 'UND', can, aplicar) + cambiarColumna_('MOVIMIENTOS', 'UND_COMPRA', can, aplicar),
              solicitudes: cambiarColumna_('SOLICITUDES', 'UND', can, aplicar), equivalencias: renombradas + quitadas.length };
  if (aplicar && n.equivalencias) reescribir_('EQUIVALENCIAS', quedan);
  return { cambios: Object.keys(cambios).sort().map(k => ({ de: k, veces: cambios[k] })), fuera: Object.keys(fuera).sort().map(k => ({ und: k, veces: fuera[k] })),
           quitadas: quitadas, filas: n };
}

function resumenUnificar(token) { auth_(token, ['ADMIN']); return planUnificar_(false); }

function unificarUnidades(token) {
  auth_(token, ['ADMIN']);
  return conBloqueo_(() => { const r = planUnificar_(true); recalcular(); return r; });
}
