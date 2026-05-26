(async () => {
    const { Worker, isMainThread } = await import("worker_threads");
    const { WebSocketServer } = await import("ws");
    const { pack, unpack } = await import("msgpackr");
    const http = await import("http");

    const PROXIES = ["http://budget-v6.whiteproxies.com:27020"];
    const prod = false;

    const names = [
        "Glory to Lord CX",
        "Hail Lord CX",
        "Lord CX is All",
        "Lord CX the Great",
        "Lord CX the Messiah",
        "Lord CX is my Savior",
        "Atone to Lord CX!",
        "Trust in Lord CX",
        "Lord CX our Salvation!",
        "Serve Lord CX",
        "Lord CX Claims",
        "Lord CX Cleanses",
        "Lord CX Commands"
    ];

    // ─────────────────────────────────────────────
    // SHARED MEMORY LAYOUT  (Float64Array, 14 slots)
    // ─────────────────────────────────────────────
    // All bots in a session share ONE SharedArrayBuffer.
    // The server writes position updates into it directly;
    // each worker reads its own values without any IPC round-trip.
    //
    //  Index │ Field
    //  ──────┼────────────────
    //    0   │ x
    //    1   │ y
    //    2   │ mouseX
    //    3   │ mouseY
    //    4   │ mouseDown      (0/1)
    //    5   │ rMouseDown     (0/1)
    //    6   │ followMouse    (0/1)
    //    7   │ feeding        (0/1)
    //    8   │ shift          (0/1)
    //    9   │ autofire       (0/1)
    //   10   │ autospin       (0/1)
    //   11   │ manualMode     (0/1)
    //   12   │ manualX
    //   13   │ manualY
    const SHARED_SLOTS = 14;
    // Precision multiplier: floats are stored as (value * PRECISION) | 0
    // so we can use Int32Array + Atomics (Atomics doesn't support Float64).
    // Coordinates like x/y go up to ~50000, mouseX/Y are small decimals.
    // 1000 gives us 3 decimal places of precision — plenty for game coords.
    const PRECISION = 1000;

    // HTTP SERVER
    const server = http.createServer((req, res) => {
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("lll elk ez big fat noob");
    });

    // WS SERVER
    function randint(a, b) {
        return Math.floor(Math.random() * (b - a + 1)) + a;
    }

    const sessions = new Map();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws, req) => {
        const addr = req.socket.remoteAddress;
        console.log(addr, "connected");

        if (!sessions.has(addr)) {
            // Each session gets its own SharedArrayBuffer for position data.
            // Float64 = 8 bytes per slot.
            const sab = new SharedArrayBuffer(SHARED_SLOTS * Int32Array.BYTES_PER_ELEMENT);
            sessions.set(addr, {
                workers: [],
                tank: "auto6",
                tanks: [],
                tankIdx: 0,
                proxyIdx: 0,
                sharedBuf: sab,
                sharedView: new Int32Array(sab)     // server writes here via Atomics
            });
        }
        const session = sessions.get(addr);

        let challenge;
        let verified = false;

        function packet(...args) {
            ws.send(pack(args));
        }

        function close() {
            ws.close();
        }

        ws.on("message", (msg) => {
            try {
                const data = unpack(msg);
                const type = data.shift();

                switch (type) {
                    case "M":
                        if (challenge || data[0] != 72011) { close(); break; }
                        challenge = randint(0b1000000000, 0b1111111111);
                        packet("M", challenge);
                        break;

                    case "C":
                        if (data[0] == (challenge ^ 845)) {
                            verified = true;
                            console.log(addr, "verified");
                        } else {
                            close();
                            console.log(addr, "true noob");
                        }
                        break;

                    case "Z":
                        session.tank = data[0];
                        if (session.tank instanceof Array) {
                            session.tanks = session.tank;
                            session.tankIdx = 0;
                            for (const worker of session.workers) {
                                const t = session.tanks[session.tankIdx];
                                worker.postMessage({ type: "tankselect", tank: t });
                                session.tankIdx = (session.tankIdx + 1) % session.tanks.length;
                            }
                        } else {
                            session.tanks = [];
                            for (const worker of session.workers) {
                                worker.postMessage({ type: "tankselect", tank: session.tank });
                            }
                        }
                        break;

                    case "F":
                        if (!verified) break;
                        {
                            const hash = data[0];
                            const count = parseInt(data[1]) || 1;
                            console.log(`Spawning ${count} worker-thread bots for hash: ${hash}`);

                            for (let i = 0; i < count; i++) {
                                setTimeout(() => {
                                    if (session.proxyIdx >= PROXIES.length) session.proxyIdx = 0;

                                    const randomName = names[Math.floor(Math.random() * names.length)];

                                    // Pass the SharedArrayBuffer to the worker at construction time.
                                    // The worker will map a Float64Array over it and poll it each tick.
                                    const worker = new Worker("./index.js", {
                                        workerData: {
                                            sharedBuf: session.sharedBuf   // zero-copy transfer
                                        }
                                    });

                                    session.workers.push(worker);

                                    worker.on("error", (err) => console.error("Worker error:", err));
                                    worker.on("exit", (code) => {
                                        if (code !== 0) console.warn(`Worker exited with code ${code}`);
                                        const idx = session.workers.indexOf(worker);
                                        if (idx !== -1) session.workers.splice(idx, 1);
                                    });

                                    // Send tank selection (still via postMessage — infrequent)
                                    if (session.tanks.length) {
                                        worker.postMessage({ type: "tankselect", tank: session.tanks[session.tankIdx] });
                                        session.tankIdx = (session.tankIdx + 1) % session.tanks.length;
                                    } else {
                                        worker.postMessage({ type: "tankselect", tank: session.tank });
                                    }

                                    // Send start config (still via postMessage — one-time)
                                    worker.postMessage({
                                        type: "start",
                                        config: {
                                            id: i,
                                            proxy: { type: "http", url: PROXIES[session.proxyIdx] },
                                            hash: "#" + hash,
                                            name: randomName,
                                            stats: [0, 0, 0, 0, 0, 0, 0, 9],
                                            type: "follow",
                                            token: "follow-8fe6ca",
                                            autoFire: false,
                                            autoRespawn: true,
                                            keys: [],
                                            keysHold: [],
                                            tank: "Auto4",
                                            chatSpam: "",
                                            squadId: hash,
                                            reconnectAttempts: 3,
                                            reconnectDelay: 15000,
                                        }
                                    });

                                    session.proxyIdx++;
                                }, i * 200);
                            }
                        }
                        break;

                    case "B":
                        if (!verified) break;
                        for (const worker of session.workers) {
                            worker.postMessage({ type: "destroy" });
                        }
                        session.workers = [];
                        break;

                    case "A":
                        if (!verified) break;
                        // ─── HOT PATH (Atomics) ──────────────────────────────────────────
                        // Atomics.store() guarantees each write is atomic — no worker can
                        // ever read a half-written value. Floats are scaled by PRECISION
                        // so they fit in Int32. Workers divide by PRECISION on read.
                        // ────────────────────────────────────────────────────────────────
                        {
                            const v = session.sharedView;
                            const P = PRECISION;
                            Atomics.store(v, 0,  ((data[0]  ?? 0) * P) | 0);  // x
                            Atomics.store(v, 1,  ((data[1]  ?? 0) * P) | 0);  // y
                            Atomics.store(v, 2,  ((data[2]  ?? 0) * P) | 0);  // mouseX
                            Atomics.store(v, 3,  ((data[3]  ?? 0) * P) | 0);  // mouseY
                            Atomics.store(v, 4,  data[4]  ? 1 : 0);           // mouseDown
                            Atomics.store(v, 5,  data[5]  ? 1 : 0);           // rMouseDown
                            Atomics.store(v, 6,  data[6]  ? 1 : 0);           // followMouse
                            Atomics.store(v, 7,  data[7]  ? 1 : 0);           // feeding
                            Atomics.store(v, 8,  data[8]  ? 1 : 0);           // shift
                            Atomics.store(v, 9,  data[9]  ? 1 : 0);           // autofire
                            Atomics.store(v, 10, data[10] ? 1 : 0);           // autospin
                            Atomics.store(v, 11, data[11] ? 1 : 0);           // manualMode
                            Atomics.store(v, 12, ((data[12] ?? 0) * P) | 0);  // manualX
                            Atomics.store(v, 13, ((data[13] ?? 0) * P) | 0);  // manualY
                        }
                        break;

                    case "T":
                        if (!verified) break;
                        for (const worker of session.workers) {
                            worker.postMessage({ type: "chat", message: data[0], spam: data[1] });
                        }
                        break;

                    default:
                        close();
                        break;
                }
            } catch (e) {
                console.error(e);
            }
        });

        ws.on("close", () => {
            console.log(addr, "disconnected (session retained)");
        });
    });

    const port = prod ? process.env.PORT : 8082;
    server.listen(port, () => {
        console.log("Server listening on port", port);
        console.log("SharedArrayBuffer support:", typeof SharedArrayBuffer !== "undefined" ? "YES" : "NO");
    });
})();
