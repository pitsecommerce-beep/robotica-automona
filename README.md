# Robótica Autónoma · Lab

Simulador web de robótica autónoma con robots ABB modelados desde su CAD oficial, física realista y órdenes por voz.

## Estado

| Paso | Contenido | Estado |
|---|---|---|
| 1 | CAD → GLB, laboratorio 3D, robot articulado con límites reales | Hecho |
| 2 | Cinemática inversa (7 ejes), MoveJ/MoveL y jog cartesiano | Hecho |
| 3 | Escenarios con física (Rapier): clasificación en línea (YuMi) y despaletizado (IRB 660) | Hecho |
| 4 | Conversación por voz (Deepgram) y cerebro (Claude) con gestos; pitidos si no hay claves | Hecho |
| 5 | Segundo robot (IRB 660 con paralelogramo), selector de robots y modo presentación | Hecho |

## Robots

| Robot | Ejes | Carga | Alcance | Escenario |
|---|---|---|---|---|
| ABB YuMi IRB 14050 | 7 | 0,5 kg | 559 mm | Clasificación de paquetes en cinta |
| ABB IRB 660-180/3.15 | 4 (paralelogramo) | 180 kg | 3150 mm | Despaletizado por color o SKU |

La cinemática del IRB 660 (ejes acoplados, bielas y cilindro compensador) sale del mecanismo Robcad de ABB y se valida en `test/irb660.test.js` contra la tabla de posiciones de la especificación.

## Voz y cerebro

- **Oído:** Deepgram en vivo por WebSocket (`/api/listen`), con texto parcial mientras se habla. Sin Deepgram, el reconocimiento del navegador. También se puede escribir.
- **Cerebro:** las órdenes claras («inicia», «para», «mete rojos y azules en el cajón A», «clasifica por SKU») las resuelve al instante un intérprete local. La charla y las órdenes complejas van a Claude con el estado de la celda y vuelven como `{ reply, emotion, actions }`.
- **Voz:** pitidos estilo droide según la emoción y, con Deepgram, voz Aura en streaming.
- **Gestos:** cada emoción tiene un gesto físico (celebrar, asentir, negar, saludar…) ejecutado con los límites reales del robot.
- **Latencia:** transcripción en streaming, vía rápida local, respuesta de Claude con esfuerzo bajo y voz que empieza a sonar con los primeros bytes.

Atajo: mantener la barra espaciadora para hablar. El botón **Presentación** pone el laboratorio a pantalla completa con cámara cinematográfica y subtítulos.

## Desarrollo

```bash
npm install
npm start          # servidor Express (APIs) en :3000
npm run dev        # Vite en http://localhost:5173 (redirige /api al :3000)
npm run preview    # build de producción + servidor Express
npm test           # pruebas de cinemática y trayectorias
```

## Movimiento

- **IK:** mínimos cuadrados amortiguados sobre los 7 ejes, con la redundancia usada para mantener una postura cercana a Home y lejos de los topes (`src/robot/Kinematics.js`).
- **MoveJ:** todos los ejes llegan a la vez con perfil trapezoidal y la velocidad máxima de cada eje.
- **MoveL:** el TCP sigue una recta a la velocidad pedida (máx. 1,5 m/s). Si algún eje superara su límite, el movimiento se alarga en lugar de saltarse la física.
- Coordenadas en pantalla en el marco de base ABB: X adelante, Y izquierda, Z arriba, en mm.

## Despliegue en Railway

Railway usa `railway.json`: compila con Vite y arranca `server/index.js`, que sirve el front y las rutas `/api/*`.
Variables de entorno (ver `.env.example`): `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`. Son opcionales: sin ellas el robot entiende las órdenes básicas en local y responde con pitidos.

## Añadir un robot

1. Copiar los STEP del fabricante en `tools/cad/source/` (no se suben al repo).
2. Crear un config como `tools/cad/irb14050.json` con el orden de eslabones y la herramienta.
3. Convertir:
   ```bash
   python -m venv .venv && .venv/bin/pip install -r tools/cad/requirements.txt
   .venv/bin/python tools/cad/convert_step.py --config tools/cad/<robot>.json --out public/robots/<robot>
   ```
   El script tesela cada eslabón, simplifica la malla y detecta los ejes articulares a partir de los cilindros coaxiales que comparten eslabones consecutivos.
4. Escribir `public/robots/<robot>/robot.json` con los límites y velocidades del datasheet.

## Nota de calibración (IRB 14050)

El cero de cada eje es la pose del CAD (brazo vertical, antebrazo horizontal) y el sentido positivo sigue la regla de la mano derecha sobre el eje detectado. Falta validarlo contra RobotStudio; si algún eje gira al revés basta con invertir su `axis` en `kinematics.json`.
