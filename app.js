// Registro de Service Worker para PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => reg.update())
            .catch(err => console.log("SW registration failed: ", err));
    });
}

// Usamos la API KEY del archivo config.js (que no se sube a GitHub)
const API_KEY = window.CONFIG.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

// Imagen de reserva para series sin póster (inline, no depende de servicios externos)
const POSTER_PLACEHOLDER = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">' +
    '<rect width="500" height="750" fill="#1e293b"/>' +
    '<text x="250" y="360" font-family="sans-serif" font-size="90" text-anchor="middle">📺</text>' +
    '<text x="250" y="440" font-family="sans-serif" font-size="32" fill="#94a3b8" text-anchor="middle">Sin imagen</text>' +
    '</svg>'
);

// Traducción única de los estados de TMDB
const TMDB_STATUS = {
    'Returning Series': { text: 'En Emisión', class: 'returning' },
    'Ended': { text: 'Finalizada', class: 'ended' },
    'Canceled': { text: 'Cancelada', class: 'canceled' },
    'Cancelled': { text: 'Cancelada', class: 'canceled' },
    'Released': { text: 'Finalizada', class: 'ended' },
    'In Production': { text: 'En Producción', class: 'production' },
    'Planned': { text: 'Planificada', class: 'production' },
    'Pilot': { text: 'Piloto', class: 'production' },
    'Post Production': { text: 'En Producción', class: 'production' }
};

function traducirEstadoTmdb(rawStatus) {
    return TMDB_STATUS[rawStatus] || { text: rawStatus || '', class: 'ended' };
}

function estadoTmdbTerminado(rawStatus) {
    return ['Ended', 'Canceled', 'Cancelled', 'Released'].includes(rawStatus);
}

// Escapar texto antes de insertarlo con innerHTML
function escapeHtml(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function claseEstado(estado) {
    return 'status-' + (estado || 'Pendiente').toLowerCase().replace(' ', '').replace('í', 'i');
}

function contarVistos(vistos) {
    let total = 0;
    for (const s in (vistos || {})) {
        if (Array.isArray(vistos[s])) total += vistos[s].length;
    }
    return total;
}

function urlTmdb(ruta, params = '') {
    return `${TMDB_BASE}${ruta}?api_key=${API_KEY}&language=es-ES${params}`;
}

function extraerMetadatos(fullData) {
    const generos = fullData.genres ? fullData.genres.map(g => g.name).join(', ') : '';
    const duracion = fullData.episode_run_time && fullData.episode_run_time.length > 0
        ? Math.round(fullData.episode_run_time.reduce((a, b) => a + b, 0) / fullData.episode_run_time.length)
        : 45; // 45 min por defecto si no hay dato
    return { generos, duracion };
}

// Inicializar PocketBase
const pb = new PocketBase(window.CONFIG.PB_URL);
pb.autoCancellation(false); // Desactivar auto-cancelado para evitar errores de peticiones simultáneas

let serieActual = null; // Estado de la serie abierta
let syncQueue = Promise.resolve(); // Cola de promesas secuencial
let pendingRecords = 0; // Contador de peticiones activas
let ratingSeleccionado = 0;
let seccionColeccionActiva = 'Pendiente';
let primeraCargaColeccion = true;

const seccionesColeccion = {
    'Pendiente': { section: 'sectionPendiente', tab: 'tabPendiente', count: 'countPendiente', grid: 'gridPendiente' },
    'Viendo': { section: 'sectionViendo', tab: 'tabViendo', count: 'countViendo', grid: 'gridViendo' },
    'Al día': { section: 'sectionAlDia', tab: 'tabAlDia', count: 'countAlDia', grid: 'gridAlDia' },
    'Vista': { section: 'sectionVista', tab: 'tabVista', count: 'countVista', grid: 'gridVista' }
};

function seleccionarSeccion(estado) {
    if (!seccionesColeccion[estado]) return;
    seccionColeccionActiva = estado;

    Object.entries(seccionesColeccion).forEach(([nombre, elementos]) => {
        const activa = nombre === estado;
        document.getElementById(elementos.tab).classList.toggle('active', activa);
        document.getElementById(elementos.tab).setAttribute('aria-selected', String(activa));
        document.getElementById(elementos.tab).tabIndex = activa ? 0 : -1;
        document.getElementById(elementos.section).classList.toggle('hidden', !activa);
    });
}

function initStars() {
    const stars = document.querySelectorAll('.star');
    stars.forEach(star => {
        star.addEventListener('click', () => {
            ratingSeleccionado = parseInt(star.getAttribute('data-value'));
            pintarEstrellas();
        });
    });
}

function updateAuthUI() {
    const isLogged = pb.authStore.isValid && pb.authStore.model;

    // Solo controlamos la pantalla de login
    document.getElementById('loginOverlay').className = isLogged ? 'hidden' : '';

    if (isLogged) {
        cargarMisSeries();
    } else {
        document.getElementById('collectionTabs').classList.add('hidden');
        primeraCargaColeccion = true;
        // Ocultar todas las secciones si no hay login
        document.getElementById('sectionPendiente').classList.add('hidden');
        document.getElementById('sectionViendo').classList.add('hidden');
        document.getElementById('sectionAlDia').classList.add('hidden');
        document.getElementById('sectionVista').classList.add('hidden');
    }
}

async function login() {
    const email = document.getElementById('emailInput').value;
    const pass = document.getElementById('passInput').value;
    const btn = document.getElementById('btnLogin');
    const loading = document.getElementById('loginLoading');

    if (!email || !pass) return;

    // Mostrar estado de carga
    btn.disabled = true;
    btn.innerText = "Iniciando sesión...";
    loading.classList.remove('hidden');

    try {
        await pb.collection('users').authWithPassword(email, pass);
        updateAuthUI();
    } catch (e) {
        alert("Error: " + e.message);
        // Restaurar estado si falla
        btn.disabled = false;
        btn.innerText = "Entrar";
        loading.classList.add('hidden');
    }
}

// --- GESTIÓN DE PANTALLAS DE AUTENTICACIÓN ---
function mostrarPantalla(id) {
    // Ocultar todas las tarjetas
    document.getElementById('cardLogin').classList.add('hidden');
    document.getElementById('cardRegistro').classList.add('hidden');
    document.getElementById('cardReset').classList.add('hidden');
    // Mostrar la seleccionada
    document.getElementById(id).classList.remove('hidden');
}

async function registrarUsuario() {
    const email = document.getElementById('regEmail').value;
    const pass = document.getElementById('regPass').value;
    const confirm = document.getElementById('regPassConfirm').value;
    const btn = document.getElementById('btnRegistro');
    const loading = document.getElementById('regLoading');

    if (!email || !pass || pass !== confirm) {
        alert("Por favor, rellena todos los campos correctamente.");
        return;
    }

    // Mostrar estado de carga
    btn.disabled = true;
    btn.innerText = "Procesando...";
    loading.classList.remove('hidden');

    try {
        await pb.collection('users').create({
            email,
            password: pass,
            passwordConfirm: confirm,
            emailVisibility: false
        });
        alert("¡Cuenta creada! Ya puedes iniciar sesión.");
        mostrarPantalla('cardLogin');
    } catch (e) {
        alert("Error al registrar: " + e.message);
    } finally {
        // Restaurar estado
        btn.disabled = false;
        btn.innerText = "Crear cuenta";
        loading.classList.add('hidden');
    }
}

async function solicitarReseteo() {
    const email = document.getElementById('resetEmail').value;
    if (!email) {
        alert("Por favor, introduce tu email.");
        return;
    }
    try {
        await pb.collection('users').requestPasswordReset(email);
        alert("Si el email existe en nuestra base, recibirás un mensaje de recuperación.");
        mostrarPantalla('cardLogin');
    } catch (e) {
        alert("Error: " + e.message);
    }
}

// Temporadas oficiales (sin especiales ni extras)
function filtrarTemporadasOficiales(seasons) {
    return (seasons || []).filter(s =>
        s.season_number > 0 &&
        !['especiales', 'specials', 'extras', 'especial'].includes((s.name || '').toLowerCase())
    );
}

function episodiosEmitidos(sData, hoy = new Date()) {
    return (sData.episodes || []).filter(ep => ep.air_date && new Date(ep.air_date) <= hoy);
}

// Descarga en paralelo el detalle de cada temporada oficial
async function obtenerDatosTemporadas(seasons, tmdbId) {
    const oficiales = filtrarTemporadasOficiales(seasons);
    const seasonsData = await Promise.all(oficiales.map(s =>
        fetch(urlTmdb(`/tv/${tmdbId}/season/${s.season_number}`)).then(res => {
            if (!res.ok) throw new Error(`TMDB ${res.status}`);
            return res.json();
        })
    ));
    return { oficiales, seasonsData };
}

function contarEmitidos(seasonsData) {
    const hoy = new Date();
    return seasonsData.reduce((acc, sData) => acc + episodiosEmitidos(sData, hoy).length, 0);
}

// Función auxiliar para unificar el conteo de episodios oficiales ya emitidos
async function obtenerTotalEpisodios(seasons, tmdbId) {
    if (!seasons || !tmdbId) return 0;
    try {
        const { seasonsData } = await obtenerDatosTemporadas(seasons, tmdbId);
        return contarEmitidos(seasonsData);
    } catch (e) {
        console.error("Error contando episodios emitidos:", e);
        // Fallback al conteo básico si falla la red
        return filtrarTemporadasOficiales(seasons).reduce((acc, s) => acc + (s.episode_count || 0), 0);
    }
}

let avisoTimeout = null;

function mostrarAvisoGuardado(texto, color) {
    const statusBadge = document.querySelector('#detailBody .status-badge');
    if (!statusBadge) return;

    clearTimeout(avisoTimeout);
    statusBadge.innerText = texto || "✓ GUARDADO";
    statusBadge.style.backgroundColor = color || "#22c55e"; // Verde éxito por defecto
    statusBadge.style.color = "white";

    avisoTimeout = setTimeout(() => {
        if (serieActual && statusBadge.isConnected) {
            statusBadge.innerText = (serieActual.estado || 'Pendiente').toUpperCase();
            statusBadge.className = `status-badge ${claseEstado(serieActual.estado)}`;
            statusBadge.style.backgroundColor = ""; // Volver al CSS
            statusBadge.style.color = "";
        }
    }, color ? 4000 : 1500);
}

async function cargarMisSeries() {
    if (!pb.authStore.isValid) return;

    // Limpiar y ocultar secciones inicialmente
    Object.values(seccionesColeccion).forEach(({ grid, section }) => {
        const g = document.getElementById(grid);
        g.innerHTML = '';
        document.getElementById(section).classList.add('hidden');
        document.querySelector(`#${section} .empty-collection`).classList.add('hidden');
    });
    document.getElementById('collectionTabs').classList.add('hidden');

    try {
        const records = await pb.collection(window.CONFIG.COLLECTION_NAME).getFullList({
            filter: pb.filter('user = {:user}', { user: pb.authStore.model.id }),
            sort: '-updated',
        });

        if (records.length === 0) {
            document.getElementById('statsContainer').classList.add('hidden');
            primeraCargaColeccion = true;
            return;
        }

        const conteos = { 'Pendiente': 0, 'Viendo': 0, 'Al día': 0, 'Vista': 0 };
        records.forEach(serie => {
            const estado = seccionesColeccion[serie.estado] ? serie.estado : 'Pendiente';
            conteos[estado]++;
        });
        Object.entries(seccionesColeccion).forEach(([estado, elementos]) => {
            document.getElementById(elementos.count).textContent = conteos[estado];
        });
        if (primeraCargaColeccion) {
            seccionColeccionActiva = Object.keys(conteos).find(estado => conteos[estado] > 0) || 'Pendiente';
            primeraCargaColeccion = false;
        }
        document.getElementById('collectionTabs').classList.remove('hidden');

        let totalEpisodiosVistos = 0;
        let totalCompletadas = 0;
        let totalMinutos = 0;
        const mapaGeneros = {};

        records.forEach(serie => {
            // Calcular episodios vistos de esta serie
            const epsDeEstaSerie = contarVistos(serie.vistos);
            totalEpisodiosVistos += epsDeEstaSerie;

            // Tiempo invertido
            const duracion = serie.duracion_media || 45;
            totalMinutos += (epsDeEstaSerie * duracion);

            // Contar géneros
            if (serie.generos) {
                serie.generos.split(', ').forEach(g => {
                    mapaGeneros[g] = (mapaGeneros[g] || 0) + 1;
                });
            }

            if (serie.estado === 'Vista') totalCompletadas++;

            const year = serie.fecha_estreno ? serie.fecha_estreno.split('-')[0] : 'Sin fecha';
            const estado = seccionesColeccion[serie.estado] ? serie.estado : 'Pendiente';
            const statusClass = claseEstado(estado);

            const tmdbStatusText = (serie.estado === 'Vista' || serie.tmdb_status === 'Finalizada') ? 'FINALIZADA' : (serie.tmdb_status || '');
            let tmdbClass = 'ended';

            if (tmdbStatusText === 'En Emisión') tmdbClass = 'returning';
            if (tmdbStatusText === 'En Producción' || tmdbStatusText === 'Planificada') tmdbClass = 'production';
            if (tmdbStatusText === 'Cancelada') tmdbClass = 'canceled';

            const card = document.createElement('div');
            card.className = 'card';
            card.onclick = () => mostrarDetalle(serie, true);

            // Calcular porcentaje para la barra de progreso
            const total = serie.total_episodios || 0;
            const porcentaje = total > 0 ? Math.min((epsDeEstaSerie / total) * 100, 100) : 0;

            card.innerHTML = `
                ${tmdbStatusText ? `<div class="card-tmdb-status tmdb-status-${tmdbClass}">${escapeHtml(tmdbStatusText)}</div>` : ''}
                <img src="${escapeHtml(serie.poster_url || POSTER_PLACEHOLDER)}" alt="${escapeHtml(serie.titulo)}" loading="lazy">
                ${estado === 'Viendo' ? `
                    <div class="card-progress" title="${epsDeEstaSerie} de ${total} episodios vistos">
                        <div class="card-progress-fill" style="width: ${porcentaje}%"></div>
                    </div>
                ` : ''}
                <div class="card-info">
                    <div class="card-title">${escapeHtml(serie.titulo)}</div>
                    <div class="card-year">
                        <span>${escapeHtml(year)}</span>
                        <span class="status-badge ${statusClass}">${estado}</span>
                    </div>
                </div>
            `;

            // Mandar a su grid correspondiente
            const seccion = seccionesColeccion[estado];
            document.getElementById(seccion.grid).appendChild(card);
        });

        Object.values(seccionesColeccion).forEach(({ section, grid }) => {
            const lista = document.getElementById(grid);
            document.querySelector(`#${section} .empty-collection`).classList.toggle('hidden', lista.children.length > 0);
        });
        seleccionarSeccion(seccionColeccionActiva);

        // Actualizar Estadísticas
        document.getElementById('statSeries').innerText = records.length;
        document.getElementById('statEpisodios').innerText = totalEpisodiosVistos;
        document.getElementById('statVistas').innerText = totalCompletadas;

        // Formatear Tiempo (Días y Horas para más claridad)
        const horasTotales = Math.floor(totalMinutos / 60);
        const dias = Math.floor(horasTotales / 24);
        const horasRestantes = horasTotales % 24;

        if (dias > 0) {
            document.getElementById('statTiempo').innerText = `${dias}d ${horasRestantes}h`;
        } else {
            document.getElementById('statTiempo').innerText = `${horasTotales}h`;
        }

        // Género Top
        const generosSorted = Object.entries(mapaGeneros).sort((a, b) => b[1] - a[1]);
        const topGenero = generosSorted.length > 0 ? escapeHtml(generosSorted[0][0]) : '-';

        let mensaje = "";
        if (topGenero === '-') {
            mensaje = "🔄 Sincronizando géneros de tu colección... (aparecerán en unos segundos)";
        } else if (totalEpisodiosVistos > 500) {
            mensaje = `🏆 ¡<strong>${horasTotales} horas</strong> de maratón! Género mas visto: <strong>${topGenero}</strong>`;
        } else if (totalEpisodiosVistos > 100) {
            mensaje = `🍿 ¡${totalEpisodiosVistos} episodios! Género mas visto: <strong>${topGenero}</strong>`;
        } else {
            mensaje = `📺 Tu colección va tomando forma. Género mas visto: <strong>${topGenero}</strong>`;
        }

        document.getElementById('statsMessage').innerHTML = mensaje;
        document.getElementById('statsContainer').classList.remove('hidden');

        // Disparar verificación de novedades en segundo plano (solo una vez por carga de página)
        if (!updateCheckDone) {
            updateCheckDone = true;
            setTimeout(() => verificarNovedades(records), 5000);
        }

    } catch (error) {
        console.error('Error al cargar series:', error);
    }
}

let verificandoNovedades = false;
let updateCheckDone = false;
let modalDesdeSegundoPlano = false; // El modal de valoración se abrió sin ficha de detalle

// Función para verificar si hay nuevos episodios o cambios de estado en TMDB
async function verificarNovedades(series) {
    if (verificandoNovedades || !series || series.length === 0) return;
    verificandoNovedades = true;

    // Verificamos las series que no estén Finalizadas/Canceladas en TMDB
    // o a las que les falten metadatos (géneros/duración)
    const seriesAVerificar = series.filter(s =>
        (s.tmdb_status !== 'Finalizada' && s.tmdb_status !== 'Cancelada') ||
        !s.generos || !s.duracion_media
    );

    let cambiosDetectados = false;
    const nuevasTerminadas = [];

    for (const serie of seriesAVerificar) {
        try {
            const res = await fetch(urlTmdb(`/tv/${serie.tmdb_id}`), { cache: 'no-cache' });
            if (!res.ok) throw new Error(`TMDB ${res.status}`);
            const fullData = await res.json();

            const rawStatus = fullData.status;
            const currentTmdbStatus = traducirEstadoTmdb(rawStatus).text;
            const { generos, duracion } = extraerMetadatos(fullData);

            console.log(`[Sync] Verificando "${serie.titulo}" (ID: ${serie.tmdb_id}). API Status: "${rawStatus}" -> "${currentTmdbStatus}"`);

            // Si está finalizada usamos el dato directo para ahorrar tráfico
            let totalAired = serie.total_episodios;
            if (estadoTmdbTerminado(rawStatus)) {
                totalAired = fullData.number_of_episodes || totalAired;
            } else {
                totalAired = await obtenerTotalEpisodios(fullData.seasons, serie.tmdb_id);
            }

            // PROTECCIÓN: si el usuario la marcó como terminada a mano, no la tocamos
            const finalizadaManual = serie.estado === 'Vista' &&
                (serie.tmdb_status === 'Finalizada' || serie.tmdb_status === 'Cancelada');

            const totalVistos = contarVistos(serie.vistos);
            let nuevoEstadoInterno = serie.estado;
            if (finalizadaManual) {
                nuevoEstadoInterno = 'Vista';
            } else if (totalVistos >= totalAired && totalAired > 0) {
                // Si ha visto todo y TMDB dice que terminó O el usuario ya la marcó como Vista, se queda en Vista
                if (currentTmdbStatus === 'Finalizada' || currentTmdbStatus === 'Cancelada' || serie.estado === 'Vista') {
                    nuevoEstadoInterno = 'Vista';
                } else {
                    nuevoEstadoInterno = 'Al día';
                }
            } else if (totalVistos > 0) {
                nuevoEstadoInterno = 'Viendo';
            } else {
                nuevoEstadoInterno = 'Pendiente';
            }

            // No dejamos que la API devuelva a "En Emisión" una serie forzada como "Finalizada"
            let finalTmdbStatus = currentTmdbStatus;
            if (serie.tmdb_status === 'Finalizada' && currentTmdbStatus === 'En Emisión') {
                finalTmdbStatus = 'Finalizada';
            }

            const nuevosGeneros = serie.generos || generos;
            const nuevaDuracion = serie.duracion_media || duracion;

            const hayCambios = nuevoEstadoInterno !== serie.estado ||
                totalAired !== serie.total_episodios ||
                finalTmdbStatus !== serie.tmdb_status ||
                nuevosGeneros !== serie.generos ||
                nuevaDuracion !== serie.duracion_media;

            if (hayCambios) {
                console.log(`[Sync] Actualizando ${serie.titulo}: ${serie.estado} -> ${nuevoEstadoInterno}`);

                await pb.collection(window.CONFIG.COLLECTION_NAME).update(serie.id, {
                    estado: nuevoEstadoInterno,
                    total_episodios: totalAired,
                    tmdb_status: finalTmdbStatus,
                    generos: nuevosGeneros,
                    duracion_media: nuevaDuracion
                });

                if (nuevoEstadoInterno === 'Vista' && serie.estado !== 'Vista') {
                    nuevasTerminadas.push({ ...serie, estado: 'Vista', tmdb_status: finalTmdbStatus, total_episodios: totalAired });
                }
                cambiosDetectados = true;
            }

            // Esperar un poco entre peticiones para no saturar
            await new Promise(r => setTimeout(r, 300));

        } catch (err) {
            console.error(`Error verificando novedades para ${serie.titulo}:`, err);
        }
    }

    verificandoNovedades = false;

    if (cambiosDetectados) {
        await cargarMisSeries(); // Recargar UI para mostrar los nuevos estados
    }

    // Avisar de las series que han terminado y pedir valoración (si no hay otra ficha abierta)
    if (nuevasTerminadas.length > 0 && !serieActual) {
        const nombres = nuevasTerminadas.map(s => `"${s.titulo}"`).join(', ');
        alert(`🎊 ${nuevasTerminadas.length === 1 ? `${nombres} ha terminado` : `Han terminado: ${nombres}`}. La hemos movido a tu lista de completadas.`);
        serieActual = nuevasTerminadas[0];
        modalDesdeSegundoPlano = true;
        mostrarFinishModal();
    }
}

async function buscarSeries() {
    const query = document.getElementById('searchInput').value;
    const resultsDiv = document.getElementById('results');
    const searchResultsSection = document.getElementById('searchResultsSection');

    if (!query) return alert("Escribe algo primero...");

    searchResultsSection.classList.remove('hidden');
    resultsDiv.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Buscando...</p>';

    try {
        // Obtener IDs de las series que ya tiene el usuario para marcarlas en el buscador
        const misSeries = await pb.collection(window.CONFIG.COLLECTION_NAME).getFullList({
            filter: pb.filter('user = {:user}', { user: pb.authStore.model.id }),
            fields: 'tmdb_id'
        });
        const idsEnColeccion = new Set(misSeries.map(s => String(s.tmdb_id)));

        let results = [];

        // Si la búsqueda es un número, intentamos buscar directamente por ID
        if (/^\d+$/.test(query.trim())) {
            const idToSearch = query.trim();

            // 1. Intentar como TMDB ID (estándar)
            const urlId = urlTmdb(`/tv/${idToSearch}`);
            const responseId = await fetch(urlId);

            if (responseId.ok) {
                const seriePorId = await responseId.json();
                results = [seriePorId];
            } else {
                // 2. Si falla, intentar como TVDB ID (usando el endpoint /find)
                console.log("[Search] No encontrado como TMDB ID, probando como TVDB ID...");
                const urlFind = urlTmdb(`/find/${idToSearch}`, '&external_source=tvdb_id');
                const responseFind = await fetch(urlFind);
                const dataFind = await responseFind.json();

                if (dataFind.tv_results && dataFind.tv_results.length > 0) {
                    results = dataFind.tv_results;
                } else {
                    // 3. Si sigue fallando, intentar búsqueda normal por si el número fuera parte de un título
                    const urlSearch = urlTmdb('/search/tv', `&query=${encodeURIComponent(query)}`);
                    const responseSearch = await fetch(urlSearch);
                    const dataSearch = await responseSearch.json();
                    results = dataSearch.results || [];
                }
            }
        } else {
            // Búsqueda normal por título
            const urlSearch = urlTmdb('/search/tv', `&query=${encodeURIComponent(query)}`);
            const responseSearch = await fetch(urlSearch);
            const dataSearch = await responseSearch.json();
            results = dataSearch.results || [];
        }

        resultsDiv.innerHTML = ''; // Limpiar mensaje de carga

        if (results.length === 0) {
            resultsDiv.innerHTML = '<p>No se encontraron series.</p>';
            return;
        }

        results.forEach(serie => {
            const yaEnLista = idsEnColeccion.has(String(serie.id));
            const poster = serie.poster_path
                ? `https://image.tmdb.org/t/p/w500${serie.poster_path}`
                : POSTER_PLACEHOLDER;

            const year = serie.first_air_date ? serie.first_air_date.split('-')[0] : 'Sin fecha';

            const card = document.createElement('div');
            card.className = 'card';
            // Si ya está en la lista, pasamos 'true' para que se abra el detalle completo
            card.onclick = () => mostrarDetalle(serie, yaEnLista);

            card.innerHTML = `
                ${yaEnLista ? '<div class="card-tmdb-status tmdb-status-returning" style="background: #6366f1; color: white;">EN TU LISTA</div>' : ''}
                <img src="${escapeHtml(poster)}" alt="${escapeHtml(serie.name)}" loading="lazy">
                <div class="card-info">
                    <div class="card-title">${escapeHtml(serie.name)}</div>
                    <div class="card-year">${escapeHtml(year)}</div>
                </div>
            `;

            resultsDiv.appendChild(card);
        });

    } catch (error) {
        console.error('Error:', error);
        resultsDiv.innerHTML = '<p>Hubo un error al buscar (mira la consola).</p>';
    }
}

async function mostrarDetalle(serie, esDeColeccion) {
    const detailView = document.getElementById('detailView');
    const detailBody = document.getElementById('detailBody');

    // Si no tenemos un ID de PocketBase (es un objeto de TMDB),
    // intentamos buscar si ya existe en nuestra colección para mostrar la ficha de seguimiento
    if (!serie.collectionId) {
        try {
            const tmdbId = serie.id || serie.tmdb_id;
            const existe = await pb.collection(window.CONFIG.COLLECTION_NAME).getList(1, 1, {
                filter: pb.filter('user = {:user} && tmdb_id = {:tmdb}', { user: pb.authStore.model.id, tmdb: String(tmdbId) })
            });

            if (existe.totalItems > 0) {
                serie = existe.items[0];
                esDeColeccion = true;
            }
        } catch (e) {
            console.error("Error al verificar pertenencia a la colección:", e);
        }
    }

    serieActual = JSON.parse(JSON.stringify(serie));
    if (!serieActual.vistos) serieActual.vistos = {};
    modalDesdeSegundoPlano = false;

    const titulo = serieActual.titulo || serieActual.name || '';
    const poster = serieActual.poster_url || (serieActual.poster_path ? `https://image.tmdb.org/t/p/w500${serieActual.poster_path}` : POSTER_PLACEHOLDER);
    const fecha = serieActual.fecha_estreno || serieActual.first_air_date;
    const year = fecha ? fecha.split('-')[0] : 'Sin fecha';
    const sinopsis = serieActual.sinopsis || serieActual.overview || 'Sin descripción disponible.';
    const puntuacion = serieActual.puntuacion_tmdb || serieActual.vote_average || '0.0';
    const tmdbId = serieActual.tmdb_id || serieActual.id;

    detailBody.innerHTML = `
        <img class="detail-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(titulo)}">
        <div class="detail-info">
            <div class="detail-title">${escapeHtml(titulo)}</div>
            <div class="detail-meta">
                <span>🗓️ ${escapeHtml(year)}</span>
                <span>⭐ <span class="rating-badge">${escapeHtml(puntuacion)}</span></span>
            </div>
            <div class="detail-synopsis">${escapeHtml(sinopsis)}</div>
            <div id="seasonsLoading">Cargando temporadas...</div>
        </div>
    `;

    detailView.style.display = 'block';
    document.body.style.overflow = 'hidden';

    try {
        const response = await fetch(urlTmdb(`/tv/${tmdbId}`));
        if (!response.ok) throw new Error(`TMDB ${response.status}`);
        const fullData = await response.json();

        const tmdbStatus = traducirEstadoTmdb(fullData.status);

        if (esDeColeccion && serieActual.id && serieActual.tmdb_status !== tmdbStatus.text) {
            // PROTECCIÓN: Si el usuario ha forzado "Finalizada", no dejamos que la API la devuelva a "En Emisión"
            if (serieActual.tmdb_status === 'Finalizada' && tmdbStatus.text === 'En Emisión') {
                console.log("[Sync] Respetando estado manual 'Finalizada' frente a API 'En Emisión'");
            } else {
                serieActual.tmdb_status = tmdbStatus.text;
                pb.collection(window.CONFIG.COLLECTION_NAME).update(serieActual.id, {
                    tmdb_status: tmdbStatus.text
                }).catch(e => console.error("Error actualizando tmdb_status:", e));
            }
        }

        let seasonsHtml = '';
        if (esDeColeccion && fullData.seasons && fullData.seasons.length > 0) {
            // ÚNICA ráfaga de peticiones para toda la información de la serie
            const { oficiales: seasonsOficiales, seasonsData } = await obtenerDatosTemporadas(fullData.seasons, tmdbId);

            const hoy = new Date();
            const totalEmitidos = contarEmitidos(seasonsData);
            serieActual.total_episodios = totalEmitidos;

            if (serieActual.estado === 'Vista') {
                // Vista Compacta para series ya terminadas
                seasonsHtml = `
                    <div class="seasons-container">
                        <div class="seasons-title">📊 Resumen de la serie</div>
                        <div style="margin-bottom: 20px; color: #94a3b8;">
                            Temporadas: <strong>${seasonsOficiales.length}</strong> Episodios: <strong>${totalEmitidos}</strong>
                        </div>
                        ${serieActual.rated ? `
                            <div class="finished-info" style="background: rgba(99, 102, 241, 0.1); border-color: var(--primary);">
                                <div style="font-weight: 600; margin-bottom: 10px; font-size: 0.9rem; text-transform: uppercase; color: var(--primary);">Tu valoración</div>
                                <div class="stars">${htmlEstrellas(serieActual.rated)}</div>
                                ${serieActual.comentarios ? `<div class="comments" style="margin-top: 10px; color: white;">"${escapeHtml(serieActual.comentarios)}"</div>` : ''}
                                <button onclick="mostrarFinishModal()" style="margin-top: 15px; padding: 6px 12px; font-size: 0.8rem; background: transparent; border: 1px solid var(--primary); color: var(--primary);">Editar reseña</button>
                            </div>
                        ` : `
                            <button class="btn-finish-save" onclick="mostrarFinishModal()" style="width: auto;">Añadir reseña final</button>
                        `}
                    </div>
                `;
            } else {
                // Vista Detallada
                seasonsHtml = `
                    <div class="seasons-container">
                        <div class="seasons-title">📂 Temporadas y Episodios</div>
                        ${seasonsData.map(sData => {
                    const sNum = Number(sData.season_number);
                    const seasonVistos = (serieActual.vistos[String(sNum)] || []).map(Number);

                    // Solo episodios ya emitidos
                    const emitidos = episodiosEmitidos(sData, hoy);
                    if (emitidos.length === 0) return ''; // No mostrar temporada sin episodios emitidos

                    const numeros = emitidos.map(ep => Number(ep.episode_number));
                    const isAllWatched = numeros.every(n => seasonVistos.includes(n));

                    const epsButtons = emitidos.map(ep => {
                        const i = Number(ep.episode_number);
                        return `
                                    <div class="episode-btn ${seasonVistos.includes(i) ? 'watched' : ''}"
                                         onclick="marcarEpisodio(${sNum}, ${i}, this)"
                                         title="Episodio ${i} (${escapeHtml(ep.air_date)})">
                                        ${i}
                                    </div>`;
                    }).join('');

                    return `
                                <div class="season-item">
                                    <div class="season-header">
                                        <div class="season-name-container">
                                            <span class="season-name">${escapeHtml(sData.name)}</span>
                                            <input type="checkbox" class="season-checkbox" ${isAllWatched ? 'checked' : ''}
                                                     data-season="${sNum}" data-eps="${numeros.join(',')}"
                                                     onchange="marcarTemporada(${sNum}, this)"
                                                     title="Marcar temporada completa">
                                        </div>
                                        <span class="episode-count">${emitidos.length} episodios</span>
                                    </div>
                                    <div class="episodes-grid" id="grid-s${sNum}">${epsButtons}</div>
                                </div>
                            `;
                }).join('')}
                    </div>
                `;
            }
        }

        detailBody.innerHTML = `
            <img class="detail-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(titulo)}">
            <div class="detail-info">
                <div style="display: flex; justify-content: space-between; align-items: start; gap: 20px; margin-bottom: 20px;">
                    <div class="detail-title" style="margin: 0;">${escapeHtml(titulo)}</div>
                    ${esDeColeccion ? `<button class="btn-delete-detail" onclick="borrarSerieActual()">🗑️ Eliminar</button>` : ''}
                </div>
                <div class="detail-meta">
                    <span>🗓️ ${escapeHtml(year)}</span>
                    <span>⭐ <span class="rating-badge">${escapeHtml(puntuacion)}</span></span>
                    <span class="tmdb-status-badge tmdb-status-${tmdbStatus.class}">${escapeHtml(tmdbStatus.text)}</span>
                    ${esDeColeccion ? (
                serieActual.estado === 'Vista' ?
                    `<a href="javascript:void(0)" onclick="revertirFinalizacion()" class="force-end-link" style="color: #ef4444;">¿No ha terminado?</a>` :
                    `<a href="javascript:void(0)" onclick="forzarFinalizacion()" class="force-end-link">¿Ha terminado?</a>`
            ) : ''}
                </div>
                <div class="detail-synopsis">${escapeHtml(sinopsis)}</div>
                ${!esDeColeccion ?
                `<button onclick="event.stopPropagation(); seleccionarSerie(serieActual)">＋ Añadir a mi lista</button>` :
                `<span class="status-badge ${claseEstado(serieActual.estado)}">${escapeHtml((serieActual.estado || 'Pendiente').toUpperCase())}</span>`
            }
                ${esDeColeccion && serieActual.estado !== 'Vista' && serieActual.rated ? `
                    <div class="finished-info">
                        <div class="stars">${htmlEstrellas(serieActual.rated)}</div>
                        ${serieActual.comentarios ? `<div class="comments">"${escapeHtml(serieActual.comentarios)}"</div>` : ''}
                    </div>
                ` : ''}

                ${seasonsHtml}
            </div>
        `;

    } catch (error) {
        console.error('Error al cargar detalles de temporadas:', error);
        const loadingDiv = document.getElementById('seasonsLoading');
        if (loadingDiv) loadingDiv.innerText = 'No se pudo cargar la información de temporadas.';
    }
}

function htmlEstrellas(rated) {
    const n = Math.max(0, Math.min(5, Number(rated) || 0));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
}

async function marcarTemporada(seasonNum, checkbox) {
    if (!serieActual || !serieActual.id) return;

    try {
        const sKey = String(seasonNum);
        // Números reales de los episodios emitidos (no siempre empiezan en 1)
        const numeros = (checkbox.dataset.eps || '').split(',').filter(Boolean).map(Number);
        const actuales = (serieActual.vistos[sKey] || []).map(Number);

        // 1. Actualizar estado local
        if (checkbox.checked) {
            serieActual.vistos[sKey] = [...new Set([...actuales, ...numeros])];
        } else {
            serieActual.vistos[sKey] = actuales.filter(n => !numeros.includes(n));
        }

        // 2. Actualizar UI de episodios
        const grid = document.getElementById(`grid-s${seasonNum}`);
        if (grid) {
            grid.querySelectorAll('.episode-btn').forEach(btn => {
                btn.classList.toggle('watched', checkbox.checked);
            });
        }

        // 3. Recalcular estado global de la serie y sincronizar
        actualizarEstadoGlobal();
        sincronizarCambios();

    } catch (error) {
        console.error('Error al marcar temporada:', error);
    }
}

// Función auxiliar para centralizar el recálculo del estado (Viendo, Vista, Pendiente)
function actualizarEstadoGlobal() {
    if (!serieActual) return;

    for (const s in serieActual.vistos) {
        if (Array.isArray(serieActual.vistos[s])) {
            serieActual.vistos[s] = [...new Set(serieActual.vistos[s].map(Number))];
        }
    }
    const totalVistos = contarVistos(serieActual.vistos);

    let nuevoEstado = 'Pendiente';
    const totalEpisodios = serieActual.total_episodios || 0;
    const tStatus = (serieActual.tmdb_status || '').toLowerCase();

    if (totalVistos > 0) {
        if (totalVistos >= totalEpisodios) {
            // Lógica de finalización vs al día
            nuevoEstado = (tStatus === 'finalizada' || tStatus === 'cancelada') ? 'Vista' : 'Al día';
        } else {
            nuevoEstado = 'Viendo';
        }
    }

    // Si acaba de terminar por completo (pasa a Vista)
    if (nuevoEstado === 'Vista' && serieActual.estado !== 'Vista') {
        window._acabaDeTerminar = true; // Flag temporal para el modal
    }

    serieActual.estado = nuevoEstado;

    const statusBadge = document.querySelector('#detailBody .status-badge');
    if (statusBadge) {
        statusBadge.innerText = nuevoEstado.toUpperCase();
        statusBadge.className = `status-badge ${claseEstado(nuevoEstado)}`;
    }
}

// Función auxiliar para centralizar la sincronización con PocketBase
function sincronizarCambios() {
    if (!serieActual) return;

    const recordId = serieActual.id;
    const titulo = serieActual.titulo;
    const dataToSave = {
        vistos: JSON.parse(JSON.stringify(serieActual.vistos)),
        estado: serieActual.estado,
        total_episodios: serieActual.total_episodios
    };

    pendingRecords++;
    syncQueue = syncQueue.then(async () => {
        try {
            await pb.collection(window.CONFIG.COLLECTION_NAME).update(recordId, dataToSave);
            mostrarAvisoGuardado();

            if (window._acabaDeTerminar) {
                window._acabaDeTerminar = false;
                setTimeout(mostrarFinishModal, 500);
            }
        } catch (err) {
            console.error("[PB] Error al guardar:", err);
            if (document.querySelector('#detailBody .status-badge') && serieActual && serieActual.id === recordId) {
                mostrarAvisoGuardado('⚠️ NO SE HA GUARDADO', '#ef4444');
            } else {
                alert(`⚠️ No se han podido guardar los cambios de "${titulo}". Revisa la conexión y vuelve a marcarlos.`);
            }
        } finally {
            pendingRecords--;
        }
    });
}

async function marcarEpisodio(seasonNum, episodeNum, btnElement) {
    if (!serieActual || !serieActual.id) return;

    try {
        const sKey = String(seasonNum);
        const lista = (serieActual.vistos[sKey] || []).map(Number);
        const index = lista.indexOf(Number(episodeNum));

        // 1. Cambio visual de episodio
        if (index > -1) {
            lista.splice(index, 1);
            btnElement.classList.remove('watched');
        } else {
            lista.push(Number(episodeNum));
            btnElement.classList.add('watched');
        }
        serieActual.vistos[sKey] = lista;

        // 2. Sincronizar checkbox de la temporada
        const checkbox = document.querySelector(`.season-checkbox[data-season="${seasonNum}"]`);
        if (checkbox) {
            const numeros = (checkbox.dataset.eps || '').split(',').filter(Boolean).map(Number);
            checkbox.checked = numeros.length > 0 && numeros.every(n => lista.includes(n));
        }

        // 3. Recalcular y Sincronizar
        actualizarEstadoGlobal();
        sincronizarCambios();

    } catch (error) {
        console.error('Error al marcar episodio:', error);
    }
}

async function cerrarDetalle() {
    const statusBadge = document.querySelector('#detailBody .status-badge');

    if (pendingRecords > 0) {
        if (statusBadge) statusBadge.innerText = "SINCRONIZANDO...";
        await syncQueue;
    }

    await new Promise(r => setTimeout(r, 200));

    document.getElementById('detailView').style.display = 'none';
    document.body.style.overflow = 'auto';
    serieActual = null;

    await cargarMisSeries();

    // Limpiar buscador y resultados
    document.getElementById('searchResultsSection').classList.add('hidden');
    document.getElementById('searchInput').value = '';
    document.getElementById('results').innerHTML = '';
}

// Función para forzar manualmente el estado de finalizada si TMDB falla
async function forzarFinalizacion() {
    if (!serieActual || !serieActual.id) return;

    const titulo = serieActual.titulo || serieActual.name;
    if (confirm(`¿Quieres marcar "${titulo}" como Finalizada manualmente? Se moverá a tu lista de completadas.`)) {
        try {
            // 1. Actualizar estado local
            serieActual.tmdb_status = 'Finalizada';
            serieActual.estado = 'Vista';

            // 2. Guardar en PocketBase
            await pb.collection(window.CONFIG.COLLECTION_NAME).update(serieActual.id, {
                tmdb_status: 'Finalizada',
                estado: 'Vista',
                total_episodios: serieActual.total_episodios
            });

            // 3. Refrescar el detalle y abrir el modal de valoración
            await mostrarDetalle(serieActual, true);
            mostrarFinishModal();
            cargarMisSeries();

        } catch (error) {
            console.error("Error al forzar finalización:", error);
            alert("Error al actualizar la serie: " + error.message);
        }
    }
}

// Función para revertir la finalización manual y dejar que TMDB mande de nuevo
async function revertirFinalizacion() {
    if (!serieActual || !serieActual.id) return;

    const titulo = serieActual.titulo || serieActual.name;
    if (confirm(`¿Quieres reactivar "${titulo}"? Volverá a usar el estado oficial de TMDB.`)) {
        try {
            // Forzamos que se comporte como una serie en emisión
            await pb.collection(window.CONFIG.COLLECTION_NAME).update(serieActual.id, {
                tmdb_status: 'En Emisión',
                estado: 'Al día'
            });

            alert(`✅ "${titulo}" reactivada. Se ha movido a tu lista de "Al día".`);
            cerrarDetalle();
        } catch (error) {
            console.error("Error al revertir finalización:", error);
            alert("Error al actualizar: " + error.message);
        }
    }
}

async function seleccionarSerie(serie) {
    if (!serie) return;
    if (!pb.authStore.isValid || !pb.authStore.model) {
        alert("Debes estar logueado en PocketBase para añadir series.");
        return;
    }

    const userModel = pb.authStore.model;
    const titulo = serie.name || serie.titulo;

    try {
        const tmdbId = serie.id || serie.tmdb_id;

        // VERIFICACIÓN DE DUPLICADOS
        const existe = await pb.collection(window.CONFIG.COLLECTION_NAME).getList(1, 1, {
            filter: pb.filter('user = {:user} && tmdb_id = {:tmdb}', { user: userModel.id, tmdb: String(tmdbId) })
        });

        if (existe.totalItems > 0) {
            alert(`⚠️ "${titulo}" ya está en tu lista.`);
            cerrarDetalle();
            return;
        }

        const tmdbRes = await fetch(urlTmdb(`/tv/${tmdbId}`));
        if (!tmdbRes.ok) throw new Error(`TMDB respondió ${tmdbRes.status}`);
        const fullData = await tmdbRes.json();

        const tmdbStatusText = traducirEstadoTmdb(fullData.status).text;
        const totalOficial = await obtenerTotalEpisodios(fullData.seasons, tmdbId);
        const { generos, duracion } = extraerMetadatos(fullData);

        const datosParaPB = {
            titulo: titulo,
            tmdb_id: tmdbId,
            sinopsis: fullData.overview || serie.overview || serie.sinopsis,
            poster_url: fullData.poster_path ? `https://image.tmdb.org/t/p/w500${fullData.poster_path}` : (serie.poster_url || ''),
            fecha_estreno: fullData.first_air_date || serie.first_air_date || serie.fecha_estreno,
            puntuacion_tmdb: fullData.vote_average || serie.puntuacion_tmdb,
            estado: 'Pendiente',
            tmdb_status: tmdbStatusText,
            total_episodios: totalOficial,
            generos: generos,
            duracion_media: duracion,
            vistos: {},
            user: userModel.id
        };

        await pb.collection(window.CONFIG.COLLECTION_NAME).create(datosParaPB);
        cerrarDetalle();
    } catch (error) {
        console.error('Error al guardar en PocketBase:', error);
        alert('❌ Error al guardar: ' + error.message);
    }
}

// Borrar la serie abierta en la ficha de detalle
async function borrarSerieActual() {
    if (!serieActual || !serieActual.id) return;
    const titulo = serieActual.titulo || serieActual.name;
    if (confirm(`¿Estás seguro de que quieres eliminar "${titulo}" de tu lista?`)) {
        try {
            await syncQueue; // Que no quede ningún guardado pendiente sobre el registro
            await pb.collection(window.CONFIG.COLLECTION_NAME).delete(serieActual.id);
            document.getElementById('detailView').style.display = 'none';
            document.body.style.overflow = 'auto';
            serieActual = null;
            cargarMisSeries();
        } catch (error) {
            console.error('Error al eliminar la serie:', error);
            alert('Error al eliminar la serie: ' + error.message);
        }
    }
}

// --- FUNCIONES MODAL FINALIZACIÓN ---
function pintarEstrellas() {
    document.querySelectorAll('.star').forEach(s => {
        s.classList.toggle('active', parseInt(s.getAttribute('data-value')) <= ratingSeleccionado);
    });
}

function mostrarFinishModal() {
    // Si ya hay reseña, la cargamos para poder editarla
    ratingSeleccionado = serieActual && serieActual.rated ? Number(serieActual.rated) : 0;
    pintarEstrellas();
    document.getElementById('finishNotes').value = (serieActual && serieActual.comentarios) || '';
    document.getElementById('finishModal').style.display = 'flex';
}

function cerrarFinishModal() {
    document.getElementById('finishModal').style.display = 'none';
    if (modalDesdeSegundoPlano) {
        modalDesdeSegundoPlano = false;
        serieActual = null;
    }
}

async function guardarFinalizacion() {
    if (!serieActual || !serieActual.id) return;

    const notas = document.getElementById('finishNotes').value;
    const data = {
        rated: ratingSeleccionado,
        comentarios: notas
    };

    try {
        await pb.collection(window.CONFIG.COLLECTION_NAME).update(serieActual.id, data);
        serieActual.rated = ratingSeleccionado;
        serieActual.comentarios = notas;
        const refrescarDetalle = !modalDesdeSegundoPlano;
        const serie = serieActual;
        cerrarFinishModal();
        if (refrescarDetalle) mostrarDetalle(serie, true); // Refrescar detalle
        cargarMisSeries(); // Refrescar grids
    } catch (e) {
        alert("Error al guardar valoración: " + e.message);
    }
}

// Restaurar y renovar la sesión guardada antes de cargar la colección.
async function inicializarApp() {
    if (pb.authStore.token) {
        try {
            await pb.collection('users').authRefresh();
        } catch (error) {
            // No borrar la sesión por un fallo temporal de red; solo si PocketBase
            // confirma que el token ya no es válido.
            if (error.status === 401 || error.status === 403) {
                pb.authStore.clear();
            } else {
                console.warn('[Auth] No se pudo renovar la sesión; se conserva el token local.', error);
            }
        }
    }

    updateAuthUI();
}

// Ejecutar al cargar
inicializarApp();
initStars();

// Permitir buscar pulsando Enter
document.getElementById('searchInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') buscarSeries();
});
