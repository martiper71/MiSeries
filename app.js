// Usamos la API KEY del archivo config.js (que no se sube a GitHub)
const API_KEY = window.CONFIG.TMDB_API_KEY;

// Inicializar PocketBase
const pb = new PocketBase(window.CONFIG.PB_URL);

let serieActual = null; // Estado de la serie abierta
let syncQueue = Promise.resolve(); // Cola de promesas secuencial
let pendingRecords = 0; // Contador de peticiones activas

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
        document.getElementById('sectionVista').classList.add('hidden');
    }
}

async function login() {
    const email = document.getElementById('emailInput').value;
    const pass = document.getElementById('passInput').value;
    try {
        await pb.collection('users').authWithPassword(email, pass);
        updateAuthUI();
    } catch (e) {
        alert("Error: " + e.message);
    }
}

function logout() {
    pb.authStore.clear();
    updateAuthUI();
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

    if (!email || !pass || pass !== confirm) {
        alert("Por favor, rellena todos los campos correctamente.");
        return;
    }

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

// Función auxiliar para unificar el conteo de episodios oficiales
function obtenerTotalEpisodios(seasons) {
    if (!seasons) return 0;
    return seasons
        .filter(s => s.season_number > 0 && !['especiales', 'specials', 'extras', 'especial'].includes(s.name.toLowerCase()))
        .reduce((acc, s) => acc + s.episode_count, 0);
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
    const gridVista = document.getElementById('gridVista');

    // Limpiar y ocultar secciones inicialmente
    [gridPendiente, gridViendo, gridVista].forEach(g => {
        g.innerHTML = '';
        g.parentElement.classList.add('hidden');
    });

    try {
        const records = await pb.collection(window.CONFIG.COLLECTION_NAME).getFullList({
            filter: `user = "${pb.authStore.model.id}"`,
            sort: '-updated',
        });

        if (records.length === 0) return;

        records.forEach(serie => {
            const year = serie.fecha_estreno ? serie.fecha_estreno.split('-')[0] : 'Sin fecha';
            const estado = serie.estado || 'Pendiente';
            const statusClass = 'status-' + estado.toLowerCase();

            const tmdbStatusText = serie.tmdb_status || '';
            let tmdbClass = 'ended';
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
            } else if (estado === 'Vista') {
                gridVista.appendChild(card);
                gridVista.parentElement.classList.remove('hidden');
            }
        });
    } catch (error) {
        console.error('Error al cargar series:', error);
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
        const url = `https://api.themoviedb.org/3/search/tv?api_key=${API_KEY}&query=${encodeURIComponent(query)}&language=es-ES`;
        const response = await fetch(url);
        const data = await response.json();

        resultsDiv.innerHTML = ''; // Limpiar mensaje de carga

        if (data.results.length === 0) {
            resultsDiv.innerHTML = '<p>No se encontraron series.</p>';
            return;
        }

        data.results.forEach(serie => {
            const poster = serie.poster_path
                ? `https://image.tmdb.org/t/p/w500${serie.poster_path}`
                : 'https://via.placeholder.com/500x750?text=No+Image';

            const year = serie.first_air_date ? serie.first_air_date.split('-')[0] : 'Sin fecha';

            const card = document.createElement('div');
            card.className = 'card';
            card.onclick = () => mostrarDetalle(serie, false);

            card.innerHTML = `
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
            'In Production': { text: 'En Producción', class: 'production' },
            'Planned': { text: 'Planificada', class: 'production' },
            'Pilot': { text: 'Piloto', class: 'production' }
        };
        const tmdbStatus = statusMap[fullData.status] || { text: fullData.status, class: 'ended' };

        if (esDeColeccion && serieActual.id && serieActual.tmdb_status !== tmdbStatus.text) {
            pb.collection(window.CONFIG.COLLECTION_NAME).update(serieActual.id, {
                tmdb_status: tmdbStatus.text
            }).catch(e => console.error("Error actualizando tmdb_status:", e));
        }

        let seasonsHtml = '';
        if (fullData.seasons && fullData.seasons.length > 0) {
            const totalOficial = obtenerTotalEpisodios(fullData.seasons);
            serieActual.total_episodios = totalOficial;

            const seasonsOficiales = fullData.seasons.filter(s =>
                s.season_number > 0 &&
                !['especiales', 'specials', 'extras', 'especial'].includes(s.name.toLowerCase())
            );

            seasonsHtml = `
                <div class="seasons-container">
                    <div class="seasons-title">📂 Temporadas y Episodios</div>
                    ${seasonsOficiales.map(s => {
                        const sKey = String(s.season_number);
                        const seasonVistos = serieActual.vistos[sKey] || [];
                        let epsButtons = '';
                        for (let i = 1; i <= s.episode_count; i++) {
                            const isWatched = seasonVistos.includes(i);
                            epsButtons += `
                                <div class="episode-btn ${isWatched ? 'watched' : ''} ${!esDeColeccion ? 'disabled' : ''}"
                                     onclick="${esDeColeccion ? `marcarEpisodio(${s.season_number}, ${i}, this)` : ''}"
                                     title="Episodio ${i}">
                                    ${i}
                                </div>`;
                        }

                        return `
                            <div class="season-item">
                                <div class="season-header">
                                    <span class="season-name">${s.name}</span>
                                    <span class="episode-count">${s.episode_count} episodios</span>
                                </div>
                                <div class="episodes-grid">${epsButtons}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }

        detailBody.innerHTML = `
            <img class="detail-poster" src="${poster}" alt="${titulo}">
            <div class="detail-info">
                <div class="detail-title">${titulo}</div>
                <div class="detail-meta">
                    <span>🗓️ ${year}</span>
                    <span>⭐ <span class="rating-badge">${puntuacion}</span></span>
                    <span class="tmdb-status-badge tmdb-status-${tmdbStatus.class}">${tmdbStatus.text}</span>
                </div>
                <div class="detail-synopsis">${sinopsis}</div>
                ${!esDeColeccion ? `<button onclick='event.stopPropagation(); seleccionarSerie(${JSON.stringify(serieActual).replace(/'/g, "&apos;")})'>＋ Añadir a mi lista</button>` : `<span class="status-badge status-${(serieActual.estado || 'pendiente').toLowerCase()}">${serieActual.estado || 'Pendiente'}</span>`}
                ${seasonsHtml}
            </div>
        `;

    } catch (error) {
        console.error('Error al cargar detalles de temporadas:', error);
        const loadingDiv = document.getElementById('seasonsLoading');
        if (loadingDiv) loadingDiv.innerText = 'No se pudo cargar la información de temporadas.';
    }
}

async function marcarEpisodio(seasonNum, episodeNum, btnElement) {
    if (!serieActual || !serieActual.id) return;

    try {
        const sKey = String(seasonNum);
        if (!serieActual.vistos[sKey]) serieActual.vistos[sKey] = [];

        const index = serieActual.vistos[sKey].indexOf(episodeNum);

        if (index > -1) {
            serieActual.vistos[sKey].splice(index, 1);
            btnElement.classList.remove('watched');
        } else {
            serieActual.vistos[sKey].push(episodeNum);
            btnElement.classList.add('watched');
        }

        let totalVistos = 0;
        for (let s in serieActual.vistos) {
            if (Array.isArray(serieActual.vistos[s])) {
                serieActual.vistos[s] = [...new Set(serieActual.vistos[s].map(Number))];
                totalVistos += serieActual.vistos[s].length;
            }
        }

        let nuevoEstado = 'Pendiente';
        if (totalVistos > 0) {
            nuevoEstado = (totalVistos >= (serieActual.total_episodios || 0)) ? 'Vista' : 'Viendo';
        }
        serieActual.estado = nuevoEstado;

        const statusBadge = document.querySelector('#detailBody .status-badge');
        if (statusBadge) {
            statusBadge.innerText = nuevoEstado.toUpperCase();
            statusBadge.className = `status-badge status-${nuevoEstado.toLowerCase()}`;
        }

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
            } catch (err) {
                console.error("[PB] Error al guardar:", err);
            } finally {
                pendingRecords--;
            }
        });

    } catch (error) {
        console.error('Error al marcar:', error);
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
        const tmdbRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${API_KEY}&language=es-ES`);
        const fullData = await tmdbRes.json();

        const statusMap = {
            'Returning Series': { text: 'En Emisión' },
            'Ended': { text: 'Finalizada' },
            'Canceled': { text: 'Cancelada' },
            'In Production': { text: 'En Producción' },
            'Planned': { text: 'Planificada' },
            'Pilot': { text: 'Piloto' }
        };
        const tmdbStatusText = statusMap[fullData.status]?.text || fullData.status;
        const totalOficial = obtenerTotalEpisodios(fullData.seasons);

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
            vistos: {},
            user: userModel.id
        };

        await pb.collection(window.CONFIG.COLLECTION_NAME).create(datosParaPB);

        document.getElementById('searchResultsSection').classList.add('hidden');
        document.getElementById('searchInput').value = '';
        document.getElementById('results').innerHTML = '';

        cerrarDetalle();
        cargarMisSeries();
    } catch (error) {
        console.error('Error al guardar en PocketBase:', error);
        alert('❌ Error al guardar: ' + error.message);
    }
}

// Ejecutar al cargar
updateAuthUI();

// Permitir buscar pulsando Enter
document.getElementById('searchInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') buscarSeries();
});
