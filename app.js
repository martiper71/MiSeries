// Registro de Service Worker para PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.log("SW registration failed: ", err));
    });
}

// Usamos la API KEY del archivo config.js (que no se sube a GitHub)
const API_KEY = window.CONFIG.TMDB_API_KEY;

// Inicializar PocketBase
const pb = new PocketBase(window.CONFIG.PB_URL);
pb.autoCancellation(false); // Desactivar auto-cancelado para evitar errores de peticiones simultáneas

let serieActual = null; // Estado de la serie abierta
let syncQueue = Promise.resolve(); // Cola de promesas secuencial
let pendingRecords = 0; // Contador de peticiones activas
let ratingSeleccionado = 0;

function initStars() {
    const stars = document.querySelectorAll('.star');
    stars.forEach(star => {
        star.addEventListener('click', () => {
            ratingSeleccionado = parseInt(star.getAttribute('data-value'));
            stars.forEach(s => {
                s.classList.toggle('active', parseInt(s.getAttribute('data-value')) <= ratingSeleccionado);
            });
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

async function logout() {
    pb.authStore.clear();

    // Limpiar Cachés de la PWA/Navegador para forzar actualización
    if ('caches' in window) {
        try {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames.map(name => caches.delete(name)));
            console.log("[PWA] Caché eliminada satisfactoriamente");
        } catch (e) {
            console.error("[PWA] Error al limpiar caché:", e);
        }
    }

    // Desvincular Service Workers (si existen) para asegurar carga fresca
    if ('serviceWorker' in navigator) {
        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (let registration of registrations) {
                await registration.unregister();
            }
        } catch (e) {
            console.error("[PWA] Error al desincorporar Service Worker:", e);
        }
    }

    // Forzar recarga completa desde el servidor (evitando caché de disco)
    window.location.reload(true);
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
            emailVisibility: true
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

// Función auxiliar para unificar el conteo de episodios oficiales ya emitidos
async function obtenerTotalEpisodios(seasons, tmdbId) {
    if (!seasons || !tmdbId) return 0;
    const hoy = new Date();

    // Filtramos las temporadas que nos interesan
    const temporadasFiltradas = seasons.filter(s =>
        s.season_number > 0 &&
        !['especiales', 'specials', 'extras', 'especial'].includes(s.name.toLowerCase())
    );

    try {
        // Lanzamos todas las peticiones en paralelo
        const promises = temporadasFiltradas.map(s =>
            fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${s.season_number}?api_key=${API_KEY}&language=es-ES`)
                .then(res => res.json())
        );

        const seasonsData = await Promise.all(promises);

        let totalEmitidos = 0;
        seasonsData.forEach(sData => {
            if (sData.episodes) {
                const emitidos = sData.episodes.filter(ep => ep.air_date && new Date(ep.air_date) <= hoy).length;
                totalEmitidos += emitidos;
            }
        });
        return totalEmitidos;
    } catch (e) {
        console.error("Error contando episodios emitidos:", e);
        // Fallback al conteo básico si falla la red
        return temporadasFiltradas.reduce((acc, s) => acc + s.episode_count, 0);
    }
}

function mostrarAvisoGuardado(texto) {
    const statusBadge = document.querySelector('#detailBody .status-badge');
    if (statusBadge) {
        const originalText = statusBadge.innerText;
        const originalClass = statusBadge.className;
        statusBadge.innerText = texto || "✓ GUARDADO";
        statusBadge.style.backgroundColor = "#22c55e"; // Verde éxito
        statusBadge.style.color = "white";

        setTimeout(() => {
            if (serieActual) {
                statusBadge.innerText = serieActual.estado.toUpperCase();
                statusBadge.className = originalClass;
                statusBadge.style.backgroundColor = ""; // Volver al CSS
                statusBadge.style.color = "";
            }
        }, 1500);
    }
}

async function cargarMisSeries() {
    if (!pb.authStore.isValid) return;

    const gridPendiente = document.getElementById('gridPendiente');
    const gridViendo = document.getElementById('gridViendo');
    const gridAlDia = document.getElementById('gridAlDia');
    const gridVista = document.getElementById('gridVista');

    // Limpiar y ocultar secciones inicialmente
    [gridPendiente, gridViendo, gridAlDia, gridVista].forEach(g => {
        g.innerHTML = '';
        g.parentElement.classList.add('hidden');
    });

    try {
        const records = await pb.collection(window.CONFIG.COLLECTION_NAME).getFullList({
            filter: `user = "${pb.authStore.model.id}"`,
            sort: '-updated',
        });

        if (records.length === 0) {
            document.getElementById('statsContainer').classList.add('hidden');
            return;
        }

        let totalEpisodiosVistos = 0;
        let totalCompletadas = 0;
        let totalMinutos = 0;
        const mapaGeneros = {};

        records.forEach(serie => {
            // Calcular episodios vistos de esta serie
            let epsDeEstaSerie = 0;
            for (let s in serie.vistos) {
                if (Array.isArray(serie.vistos[s])) {
                    epsDeEstaSerie += serie.vistos[s].length;
                }
            }
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
            const estado = serie.estado || 'Pendiente';
            const statusClass = 'status-' + estado.toLowerCase().replace(' ', '').replace('í', 'i');

            const tmdbStatusText = (serie.estado === 'Vista' || serie.tmdb_status === 'Finalizada') ? 'FINALIZADA' : (serie.tmdb_status || '');
            let tmdbClass = (serie.estado === 'Vista' || serie.tmdb_status === 'Finalizada') ? 'ended' : 'ended';

            if (tmdbStatusText === 'En Emisión') tmdbClass = 'returning';
            if (tmdbStatusText === 'En Producción' || tmdbStatusText === 'Planificada') tmdbClass = 'production';
            if (tmdbStatusText === 'Cancelada') tmdbClass = 'canceled';

            const card = document.createElement('div');
            card.className = 'card';
            card.onclick = () => mostrarDetalle(serie, true);

            card.innerHTML = `
                ${tmdbStatusText ? `<div class="card-tmdb-status tmdb-status-${tmdbClass}">${tmdbStatusText}</div>` : ''}
                <img src="${serie.poster_url || 'https://via.placeholder.com/500x750?text=No+Image'}" alt="${serie.titulo}">
                <div class="card-info">
                    <div class="card-title">${serie.titulo}</div>
                    <div class="card-year">
                        <span>${year}</span>
                        <span class="status-badge ${statusClass}">${estado}</span>
                    </div>
                </div>
            `;

            // Mandar a su grid correspondiente
            if (estado === 'Pendiente') {
                gridPendiente.appendChild(card);
                gridPendiente.parentElement.classList.remove('hidden');
            } else if (estado === 'Viendo') {
                gridViendo.appendChild(card);
                gridViendo.parentElement.classList.remove('hidden');
            } else if (estado === 'Al día') {
                gridAlDia.appendChild(card);
                gridAlDia.parentElement.classList.remove('hidden');
            } else if (estado === 'Vista') {
                gridVista.appendChild(card);
                gridVista.parentElement.classList.remove('hidden');
            }
        });

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
        const topGenero = generosSorted.length > 0 ? generosSorted[0][0] : '-';

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

// Función para verificar si hay nuevos episodios o cambios de estado en TMDB
async function verificarNovedades(series) {
    if (verificandoNovedades || !series || series.length === 0) return;
    verificandoNovedades = true;

    // Verificamos todas las series que no estén ya marcadas como Finalizadas/Canceladas en TMDB
    // o que tengan episodios pendientes de emitir.
    // Verificamos series para ver si hay nuevos episodios O si les faltan metadatos (géneros/duración)
    const seriesAVerificar = series.filter(s =>
        (s.tmdb_status !== 'Finalizada' && s.tmdb_status !== 'Cancelada') ||
        (!s.generos || !s.duracion_media)
    );

    let cambiosDetectados = false;

    for (const serie of seriesAVerificar) {
        try {
            // Añadimos cache-buster para asegurar datos frescos de la API
            const res = await fetch(`https://api.themoviedb.org/3/tv/${serie.tmdb_id}?api_key=${API_KEY}&language=es-ES&t=${Date.now()}`);
            const fullData = await res.json();

            // 3. Traducir estado de TMDB (Mapeo ultra-exhaustivo)
            const statusMap = {
                'Returning Series': 'En Emisión',
                'Ended': 'Finalizada',
                'Canceled': 'Cancelada',
                'Cancelled': 'Cancelada',
                'In Production': 'En Producción',
                'Planned': 'Planificada',
                'Pilot': 'Piloto',
                'Released': 'Finalizada',
                'Post Production': 'En Producción'
            };
            const rawStatus = fullData.status;
            const currentTmdbStatus = statusMap[rawStatus] || rawStatus;

            // Aprovechar para rellenar géneros y duración si faltan (para series viejas)
            const generos = fullData.genres ? fullData.genres.map(g => g.name).join(', ') : '';
            const duracion = fullData.episode_run_time && fullData.episode_run_time.length > 0
                ? Math.round(fullData.episode_run_time.reduce((a, b) => a + b, 0) / fullData.episode_run_time.length)
                : 45;

            console.log(`[Sync] Verificando "${serie.titulo}" (ID: ${serie.tmdb_id}). API Status: "${rawStatus}" -> "${currentTmdbStatus}"`);

            // 4. Calcular episodios: Si está finalizada usamos el dato directo para ahorrar tráfico
            let totalAired = serie.total_episodios;
            if (rawStatus === 'Ended' || rawStatus === 'Canceled' || rawStatus === 'Cancelled' || rawStatus === 'Released') {
                totalAired = fullData.number_of_episodes || totalAired;
            } else {
                totalAired = await obtenerTotalEpisodios(fullData.seasons, serie.tmdb_id);
            }

            let totalVistos = 0;
            for (let s in serie.vistos) {
                if (Array.isArray(serie.vistos[s])) totalVistos += serie.vistos[s].length;
            }

            let nuevoEstadoInterno = serie.estado;
            if (totalVistos >= totalAired && totalAired > 0) {
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

            // 5. Si hay cambios reales, actualizamos PocketBase
            if (nuevoEstadoInterno !== serie.estado || totalAired !== serie.total_episodios || currentTmdbStatus !== serie.tmdb_status) {
                const pasaAVista = nuevoEstadoInterno === 'Vista' && serie.estado !== 'Vista';

                console.log(`[Sync] Actualizando ${serie.titulo}: ${serie.estado} -> ${nuevoEstadoInterno}`);
                // PROTECCIÓN: Si el usuario ha forzado "Finalizada", no dejamos que la API la devuelva a "En Emisión"
                let finalTmdbStatus = currentTmdbStatus;
                if (serie.tmdb_status === 'Finalizada' && currentTmdbStatus === 'En Emisión') {
                    finalTmdbStatus = 'Finalizada';
                }

                await pb.collection(window.CONFIG.COLLECTION_NAME).update(serie.id, {
                    estado: nuevoEstadoInterno,
                    total_episodios: totalAired,
                    tmdb_status: finalTmdbStatus,
                    generos: serie.generos || generos,
                    duracion_media: serie.duracion_media || duracion
                });

                if (pasaAVista) {
                    // Si la serie ha finalizado, avisamos al usuario y pedimos valoración
                    serieActual = serie; // Asignamos como actual para el modal
                    serieActual.estado = 'Vista';
                    alert(`🎊 ¡"${serie.titulo}" ha sido ${currentTmdbStatus.toLowerCase()}! La hemos movido a tu lista de completadas.`);
                    mostrarFinishModal();
                    cambiosDetectados = true;
                    // Detenemos la verificación de más series para que el usuario pueda valorar esta
                    verificandoNovedades = false;
                    return;
                }

                cambiosDetectados = true;
            }

            // Esperar un poco entre peticiones para no saturar
            await new Promise(r => setTimeout(r, 300));

        } catch (err) {
            console.error(`Error verificando novedades para ${serie.titulo}:`, err);
        }
    }

    if (cambiosDetectados) {
        cargarMisSeries(); // Recargar UI para mostrar los nuevos estados
    }

    verificandoNovedades = false;
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
            filter: `user = "${pb.authStore.model.id}"`,
            fields: 'tmdb_id'
        });
        const idsEnColeccion = new Set(misSeries.map(s => String(s.tmdb_id)));

        let results = [];

        // Si la búsqueda es un número, intentamos buscar directamente por ID
        if (/^\d+$/.test(query.trim())) {
            const idToSearch = query.trim();

            // 1. Intentar como TMDB ID (estándar)
            const urlId = `https://api.themoviedb.org/3/tv/${idToSearch}?api_key=${API_KEY}&language=es-ES`;
            const responseId = await fetch(urlId);

            if (responseId.ok) {
                const seriePorId = await responseId.json();
                results = [seriePorId];
            } else {
                // 2. Si falla, intentar como TVDB ID (usando el endpoint /find)
                console.log("[Search] No encontrado como TMDB ID, probando como TVDB ID...");
                const urlFind = `https://api.themoviedb.org/3/find/${idToSearch}?api_key=${API_KEY}&external_source=tvdb_id&language=es-ES`;
                const responseFind = await fetch(urlFind);
                const dataFind = await responseFind.json();

                if (dataFind.tv_results && dataFind.tv_results.length > 0) {
                    results = dataFind.tv_results;
                } else {
                    // 3. Si sigue fallando, intentar búsqueda normal por si el número fuera parte de un título
                    const urlSearch = `https://api.themoviedb.org/3/search/tv?api_key=${API_KEY}&query=${encodeURIComponent(query)}&language=es-ES`;
                    const responseSearch = await fetch(urlSearch);
                    const dataSearch = await responseSearch.json();
                    results = dataSearch.results;
                }
            }
        } else {
            // Búsqueda normal por título
            const urlSearch = `https://api.themoviedb.org/3/search/tv?api_key=${API_KEY}&query=${encodeURIComponent(query)}&language=es-ES`;
            const responseSearch = await fetch(urlSearch);
            const dataSearch = await responseSearch.json();
            results = dataSearch.results;
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
                : 'https://via.placeholder.com/500x750?text=No+Image';

            const year = serie.first_air_date ? serie.first_air_date.split('-')[0] : 'Sin fecha';

            const card = document.createElement('div');
            card.className = 'card';
            // Si ya está en la lista, pasamos 'true' para que se abra el detalle completo
            card.onclick = () => mostrarDetalle(serie, yaEnLista);

            card.innerHTML = `
                ${yaEnLista ? '<div class="card-tmdb-status tmdb-status-returning" style="background: #6366f1; color: white;">EN TU LISTA</div>' : ''}
                <img src="${poster}" alt="${serie.name}">
                <div class="card-info">
                    <div class="card-title">${serie.name}</div>
                    <div class="card-year">${year}</div>
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
                filter: `user = "${pb.authStore.model.id}" && tmdb_id = "${tmdbId}"`
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

    const titulo = serieActual.titulo || serieActual.name;
    const poster = serieActual.poster_url || (serieActual.poster_path ? `https://image.tmdb.org/t/p/w500${serieActual.poster_path}` : 'https://via.placeholder.com/500x750?text=No+Image');
    const fecha = serieActual.fecha_estreno || serieActual.first_air_date;
    const year = fecha ? fecha.split('-')[0] : 'Sin fecha';
    const sinopsis = serieActual.sinopsis || serieActual.overview || 'Sin descripción disponible.';
    const puntuacion = serieActual.puntuacion_tmdb || serieActual.vote_average || '0.0';
    const tmdbId = serieActual.tmdb_id || serieActual.id;

    detailBody.innerHTML = `
        <img class="detail-poster" src="${poster}" alt="${titulo}">
        <div class="detail-info">
            <div class="detail-title">${titulo}</div>
            <div class="detail-meta">
                <span>🗓️ ${year}</span>
                <span>⭐ <span class="rating-badge">${puntuacion}</span></span>
            </div>
            <div class="detail-synopsis">${sinopsis}</div>
            <div id="seasonsLoading">Cargando temporadas...</div>
        </div>
    `;

    detailView.style.display = 'block';
    document.body.style.overflow = 'hidden';

    try {
        const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${API_KEY}&language=es-ES`;
        const response = await fetch(url);
        const fullData = await response.json();

        const statusMap = {
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
        const tmdbStatus = statusMap[fullData.status] || { text: fullData.status, class: 'ended' };

        if (esDeColeccion && serieActual.id && serieActual.tmdb_status !== tmdbStatus.text) {
            // PROTECCIÓN: Si el usuario ha forzado "Finalizada", no dejamos que la API la devuelva a "En Emisión"
            if (serieActual.tmdb_status === 'Finalizada' && tmdbStatus.text === 'En Emisión') {
                console.log("[Sync] Respetando estado manual 'Finalizada' frente a API 'En Emisión'");
            } else {
                pb.collection(window.CONFIG.COLLECTION_NAME).update(serieActual.id, {
                    tmdb_status: tmdbStatus.text
                }).catch(e => console.error("Error actualizando tmdb_status:", e));
            }
        }

        let seasonsHtml = '';
        if (esDeColeccion && fullData.seasons && fullData.seasons.length > 0) {
            const seasonsOficiales = fullData.seasons.filter(s =>
                s.season_number > 0 &&
                !['especiales', 'specials', 'extras', 'especial'].includes(s.name.toLowerCase())
            );

            // ÚNICA ráfaga de peticiones para toda la información de la serie
            const seasonsDataPromises = seasonsOficiales.map(s =>
                fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${s.season_number}?api_key=${API_KEY}&language=es-ES`).then(r => r.json())
            );
            const seasonsData = await Promise.all(seasonsDataPromises);

            // Calculamos totalEmitidos reutilizando los datos ya descargados
            const hoy = new Date();
            let totalEmitidos = 0;
            seasonsData.forEach(sData => {
                if (sData.episodes) {
                    totalEmitidos += sData.episodes.filter(ep => ep.air_date && new Date(ep.air_date) <= hoy).length;
                }
            });
            serieActual.total_episodios = totalEmitidos;

            if (esDeColeccion && serieActual.estado === 'Vista') {
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
                                <div class="stars">${'★'.repeat(serieActual.rated)}${'☆'.repeat(5 - serieActual.rated)}</div>
                                ${serieActual.comentarios ? `<div class="comments" style="margin-top: 10px; color: white;">"${serieActual.comentarios}"</div>` : ''}
                                <button onclick="mostrarFinishModal()" style="margin-top: 15px; padding: 6px 12px; font-size: 0.8rem; background: transparent; border: 1px solid var(--primary); color: var(--primary);">Editar reseña</button>
                            </div>
                        ` : `
                            <button class="btn-finish-save" onclick="mostrarFinishModal()" style="width: auto;">Añadir reseña final</button>
                        `}
                    </div>
                `;
            } else if (esDeColeccion) {
                // Vista Detallada
                seasonsHtml = `
                    <div class="seasons-container">
                        <div class="seasons-title">📂 Temporadas y Episodios</div>
                        ${seasonsData.map(sData => {
                    const sNum = sData.season_number;
                    const sKey = String(sNum);
                    const seasonVistos = serieActual.vistos[sKey] || [];

                    // Filtrar solo episodios ya emitidos
                    const episodiosEmitidos = sData.episodes.filter(ep => ep.air_date && new Date(ep.air_date) <= hoy);
                    if (episodiosEmitidos.length === 0) return ''; // No mostrar temporada si no hay episodios emitidos

                    const isAllWatched = seasonVistos.length === episodiosEmitidos.length;

                    let epsButtons = episodiosEmitidos.map(ep => {
                        const i = ep.episode_number;
                        const isWatched = seasonVistos.includes(i);
                        return `
                                    <div class="episode-btn ${isWatched ? 'watched' : ''}"
                                         onclick="marcarEpisodio(${sNum}, ${i}, this)"
                                         title="Episodio ${i} (${ep.air_date})">
                                        ${i}
                                    </div>`;
                    }).join('');

                    return `
                                <div class="season-item">
                                    <div class="season-header">
                                        <div class="season-name-container">
                                            <span class="season-name">${sData.name}</span>
                                            <input type="checkbox" class="season-checkbox" ${isAllWatched ? 'checked' : ''}
                                                     onchange="marcarTemporada(${sNum}, ${episodiosEmitidos.length}, this)"
                                                     title="Marcar temporada completa">
                                        </div>
                                        <span class="episode-count">${episodiosEmitidos.length} episodios</span>
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
            <img class="detail-poster" src="${poster}" alt="${titulo}">
            <div class="detail-info">
                <div style="display: flex; justify-content: space-between; align-items: start; gap: 20px; margin-bottom: 20px;">
                    <div class="detail-title" style="margin: 0;">${titulo}</div>
                    ${esDeColeccion ? `<button class="btn-delete-detail" onclick="borrarSerie('${serieActual.id}', '${titulo.replace(/'/g, "\\'")}')">🗑️ Eliminar</button>` : ''}
                </div>
                <div class="detail-meta">
                    <span>🗓️ ${year}</span>
                    <span>⭐ <span class="rating-badge">${puntuacion}</span></span>
                    <span class="tmdb-status-badge tmdb-status-${tmdbStatus.class}">${tmdbStatus.text}</span>
                    ${esDeColeccion ? (
                serieActual.tmdb_status === 'Finalizada' && fullData.status === 'Returning Series' ?
                    `<a href="javascript:void(0)" onclick="revertirFinalizacion()" class="force-end-link" style="color: #ef4444;">¿No ha finalizado?</a>` :
                    (tmdbStatus.text !== 'Finalizada' && tmdbStatus.text !== 'Cancelada' ?
                        `<a href="javascript:void(0)" onclick="forzarFinalizacion()" class="force-end-link">¿Ha finalizado?</a>` : '')
            ) : ''}
                </div>
                <div class="detail-synopsis">${sinopsis}</div>
                ${!esDeColeccion ?
                `<button onclick='event.stopPropagation(); seleccionarSerie(${JSON.stringify(serieActual).replace(/'/g, "&apos;")})'>＋ Añadir a mi lista</button>` :
                `<span class="status-badge status-${(serieActual.estado || 'pendiente').toLowerCase().replace(' ', '').replace('í', 'i')}">${(serieActual.estado || 'Pendiente').toUpperCase()}</span>`
            }
                ${esDeColeccion && serieActual.estado !== 'Vista' && serieActual.rated ? `
                    <div class="finished-info">
                        <div class="stars">${'★'.repeat(serieActual.rated)}${'☆'.repeat(5 - serieActual.rated)}</div>
                        ${serieActual.comentarios ? `<div class="comments">"${serieActual.comentarios}"</div>` : ''}
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

async function marcarTemporada(seasonNum, episodeCount, checkbox) {
    if (!serieActual || !serieActual.id) return;

    try {
        const sKey = String(seasonNum);
        const isChecked = checkbox.checked;

        // 1. Actualizar estado local
        if (isChecked) {
            // Todos vistos
            serieActual.vistos[sKey] = Array.from({ length: episodeCount }, (_, i) => i + 1);
        } else {
            // Ninguno visto
            serieActual.vistos[sKey] = [];
        }

        // 2. Actualizar UI de episodios
        const grid = document.getElementById(`grid-s${seasonNum}`);
        if (grid) {
            const buttons = grid.querySelectorAll('.episode-btn');
            buttons.forEach(btn => {
                if (isChecked) btn.classList.add('watched');
                else btn.classList.remove('watched');
            });
        }

        // 3. Recalcular estado global de la serie
        actualizarEstadoGlobal();

        // 4. Sincronizar
        sincronizarCambios();

    } catch (error) {
        console.error('Error al marcar temporada:', error);
    }
}

// Función auxiliar para centralizar el recálculo del estado (Viendo, Vista, Pendiente)
function actualizarEstadoGlobal() {
    if (!serieActual) return;

    let totalVistos = 0;
    for (let s in serieActual.vistos) {
        if (Array.isArray(serieActual.vistos[s])) {
            serieActual.vistos[s] = [...new Set(serieActual.vistos[s].map(Number))];
            totalVistos += serieActual.vistos[s].length;
        }
    }

    let nuevoEstado = 'Pendiente';
    const totalEpisodios = serieActual.total_episodios || 0;
    const tStatus = (serieActual.tmdb_status || '').toLowerCase();

    if (totalVistos > 0) {
        if (totalVistos >= totalEpisodios) {
            // Lógica de finalización vs al día
            if (tStatus === 'finalizada' || tStatus === 'cancelada') {
                nuevoEstado = 'Vista';
            } else {
                nuevoEstado = 'Al día';
            }
        } else {
            nuevoEstado = 'Viendo';
        }
    }

    // Si acaba de terminar por completo (pasa a Vista)
    const acabaDeTerminar = nuevoEstado === 'Vista' && serieActual.estado !== 'Vista';

    serieActual.estado = nuevoEstado;

    const statusBadge = document.querySelector('#detailBody .status-badge');
    if (statusBadge) {
        let displayState = nuevoEstado.toUpperCase();
        statusBadge.innerText = displayState;
        const stateClass = nuevoEstado.toLowerCase().replace(' ', '').replace('í', 'i');
        statusBadge.className = `status-badge status-${stateClass}`;
    }

    if (acabaDeTerminar) {
        window._acabaDeTerminar = true; // Flag temporal para el modal
    }
}

// Función auxiliar para centralizar la sincronización con PocketBase
function sincronizarCambios() {
    if (!serieActual) return;

    const recordId = serieActual.id;
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
        } finally {
            pendingRecords--;
        }
    });
}

async function marcarEpisodio(seasonNum, episodeNum, btnElement) {
    if (!serieActual || !serieActual.id) return;

    try {
        const sKey = String(seasonNum);
        if (!serieActual.vistos[sKey]) serieActual.vistos[sKey] = [];

        const index = serieActual.vistos[sKey].indexOf(episodeNum);

        // 1. Cambio visual de episodio
        if (index > -1) {
            serieActual.vistos[sKey].splice(index, 1);
            btnElement.classList.remove('watched');
        } else {
            serieActual.vistos[sKey].push(episodeNum);
            btnElement.classList.add('watched');
        }

        // 2. Sincronizar checkbox de la temporada
        const checkbox = document.querySelector(`.season-item .season-checkbox[onchange*="marcarTemporada(${seasonNum},"]`);
        if (checkbox) {
            const match = checkbox.getAttribute('onchange').match(/marcarTemporada\(\d+,\s*(\d+),/);
            if (match) {
                const totalEpsTemporada = parseInt(match[1]);
                checkbox.checked = (serieActual.vistos[sKey].length === totalEpsTemporada);
            }
        }

        // 3. Recalcular y Sincronizar
        actualizarEstadoGlobal();
        sincronizarCambios();

    } catch (error) {
        console.error('Error al marcar episodio:', error);
    }
}

async function cerrarDetalle() {
    if (!serieActual) return;

    const statusBadge = document.querySelector('#detailBody .status-badge');

    if (pendingRecords > 0) {
        if (statusBadge) statusBadge.innerText = "SINCRONIZANDO...";
        await syncQueue;
    }

    await new Promise(r => setTimeout(r, 200));

    document.getElementById('detailView').style.display = 'none';
    document.body.style.overflow = 'auto';

    await cargarMisSeries();
    serieActual = null;

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

            // 3. Abrir modal de valoración
            mostrarFinishModal();

            // 4. Refrescar el detalle y los grids
            mostrarDetalle(serieActual, true);
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
            // Ponemos un estado temporal para que el sistema de sincronización lo recoja
            // O mejor, lo forzamos nosotros ahora mismo
            const response = await fetch(`https://api.themoviedb.org/3/tv/${serieActual.tmdb_id}?api_key=${API_KEY}&language=es-ES`);
            const fullData = await response.json();

            // Forzamos que se comporte como una serie en emisión
            await pb.collection(window.CONFIG.COLLECTION_NAME).update(serieActual.id, {
                tmdb_status: 'En Emisión',
                estado: 'Al día'
            });

            alert(`✅ "${titulo}" reactivada. Se ha movido a tu lista de "Al día".`);

            // Refrescar todo
            cerrarDetalle();
        } catch (error) {
            console.error("Error al revertir finalización:", error);
            alert("Error al actualizar: " + error.message);
        }
    }
}

async function seleccionarSerie(serie) {
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
            filter: `user = "${userModel.id}" && tmdb_id = "${tmdbId}"`
        });

        if (existe.totalItems > 0) {
            alert(`⚠️ "${titulo}" ya está en tu lista.`);

            // Limpiar búsqueda
            document.getElementById('searchResultsSection').classList.add('hidden');
            document.getElementById('searchInput').value = '';
            document.getElementById('results').innerHTML = '';

            cerrarDetalle();
            return;
        }

        const tmdbRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${API_KEY}&language=es-ES`);
        const fullData = await tmdbRes.json();

        const statusMap = {
            'Returning Series': { text: 'En Emisión' },
            'Ended': { text: 'Finalizada' },
            'Canceled': { text: 'Cancelada' },
            'Cancelled': { text: 'Cancelada' },
            'Released': { text: 'Finalizada' },
            'In Production': { text: 'En Producción' },
            'Planned': { text: 'Planificada' },
            'Pilot': { text: 'Piloto' }
        };
        const tmdbStatusText = statusMap[fullData.status]?.text || fullData.status;
        const totalOficial = await obtenerTotalEpisodios(fullData.seasons, tmdbId);

        // Extraer géneros y duración media
        const generos = fullData.genres ? fullData.genres.map(g => g.name).join(', ') : '';
        const duracion = fullData.episode_run_time && fullData.episode_run_time.length > 0
            ? Math.round(fullData.episode_run_time.reduce((a, b) => a + b, 0) / fullData.episode_run_time.length)
            : 45; // 45 min por defecto si no hay dato

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

        document.getElementById('searchResultsSection').classList.add('hidden');
        document.getElementById('searchInput').value = '';
        document.getElementById('results').innerHTML = '';

        cerrarDetalle();
    } catch (error) {
        console.error('Error al guardar en PocketBase:', error);
        alert('❌ Error al guardar: ' + error.message);
    }
}

// Función para borrar una serie de la colección
async function borrarSerie(id, titulo) {
    if (confirm(`¿Estás seguro de que quieres eliminar "${titulo}" de tu lista?`)) {
        try {
            await pb.collection(window.CONFIG.COLLECTION_NAME).delete(id);
            document.getElementById('detailView').style.display = 'none';
            document.body.style.overflow = 'auto';
            cargarMisSeries();
        } catch (error) {
            console.error('Error al eliminar la serie:', error);
            alert('Error al eliminar la serie: ' + error.message);
        }
    }
}

// --- FUNCIONES MODAL FINALIZACIÓN ---
function mostrarFinishModal() {
    ratingSeleccionado = 0;
    document.querySelectorAll('.star').forEach(s => s.classList.remove('active'));
    document.getElementById('finishNotes').value = '';
    document.getElementById('finishModal').style.display = 'flex';
}

function cerrarFinishModal() {
    document.getElementById('finishModal').style.display = 'none';
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
        cerrarFinishModal();
        mostrarDetalle(serieActual, true); // Refrescar detalle
        cargarMisSeries(); // Refrescar grids
    } catch (e) {
        alert("Error al guardar valoración: " + e.message);
    }
}

// Ejecutar al cargar
updateAuthUI();
initStars();

// Permitir buscar pulsando Enter
document.getElementById('searchInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') buscarSeries();
});
