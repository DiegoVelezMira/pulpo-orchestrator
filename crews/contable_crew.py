#!/usr/bin/env python3
"""
Crew Contable — Orquestación de agentes para procesamiento de documentos contables colombianos
Sistema: Pulpo Orchestrator
Autor: Diego Vélez
Fecha: Oct 2026

Principio de diseño (16-oct-2026): los NUMEROS tributarios los calcula codigo
determinista (reglas_tributarias.py), no los modelos. Los agentes clasifican,
detectan anomalias y explican; el asiento que proponen se verifica contra el
calculo oficial y el estado final lo decide el codigo.
"""

import os
import sys
import json
import logging
from typing import Optional
from datetime import datetime, date
from anthropic import Anthropic

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reglas_tributarias import prevalidar, calcular, verificar_asiento, normalizar_tipo

# Configurar logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger(__name__)

# Inicializar cliente Anthropic
client = Anthropic()


def _limpiar_json(texto):
    """Quita la cerca ```json ... ``` que los modelos suelen agregar."""
    t = (texto or "").strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else ""
        t = t.rstrip()
        if t.endswith("```"):
            t = t[:-3]
    return t.strip()


def _paso_ok(resultado):
    """True si el agente respondio con status de exito."""
    return str((resultado or {}).get("status", "")).strip().lower() in ("éxito", "exito")


MODEL = "claude-opus-4-6"
MAX_TOKENS = 6000


class ContableAgent:
    """Agente contable base con memoria de conversación"""

    def __init__(self, name: str, role: str, expertise: str):
        self.name = name
        self.role = role
        self.expertise = expertise
        self.conversation_history = []

    def _build_system_prompt(self) -> str:
        """Construye el prompt del sistema según el rol"""
        base_prompt = f"""Eres {self.name}, un {self.role} experto en contabilidad colombiana.
Tu expertise: {self.expertise}

Contexto normativo:
- PUC (Plan Único de Cuentas) colombiano
- Normas NIIF para PYMEs
- Resolución 0489 de 2023 (DIAN)
- IVA: 5% (bienes básicos), 19% (estándar), exento (servicios financieros)

REGLA CRÍTICA SOBRE CÁLCULOS:
- El IVA, la retención en la fuente, la ReteIVA y el neto a pagar ya vienen calculados por el sistema en el campo 'calculos_oficiales', con las reglas vigentes.
- NO recalcules esos valores, NO apliques tarifas ni bases mínimas de memoria y NO contradigas 'calculos_oficiales'. Úsalos tal cual.
- Si 'calculos_oficiales.determinable' es false, o falta información para decidir, responde status "pendiente" e indica qué falta.

Instrucciones:
1. Responde SIEMPRE en JSON válido
2. Sé preciso y referencia normativas cuando aplique
3. Cuando no puedas resolver, sugiere escalación
4. Valida datos según estándares colombianos
5. Mantén trazabilidad de decisiones
6. Sé conciso: responde solo con el JSON, sin texto fuera de él y sin repetir el documento original.
7. En 'detalles' incluye solo lo esencial (máximo 8 campos, textos de máximo 2 frases); 'notas_audit' en máximo 2 frases.

Responde en este formato JSON:
{{
    "status": "éxito|error|pendiente",
    "resultado": "descripción breve",
    "detalles": {{"key": "value"}},
    "siguiente_paso": "siguiente acción o agente",
    "notas_audit": "trazabilidad de decisión"
}}"""
        return base_prompt

    def execute(self, task_description: str, document_data: dict) -> dict:
        """Ejecuta la tarea del agente"""
        try:
            self.conversation_history.append({
                "role": "user",
                "content": f"""Procesa este documento contable:

Documento:
FECHA DE HOY: {datetime.now().strftime('%Y-%m-%d')}. Usala para juzgar si una fecha del documento es futura o pasada.

{json.dumps(document_data, indent=2, ensure_ascii=False)}

Tarea: {task_description}"""
            })

            response = client.messages.create(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=self._build_system_prompt(),
                messages=self.conversation_history
            )

            result_text = response.content[0].text
            self.conversation_history.append({
                "role": "assistant",
                "content": result_text
            })

            if getattr(response, "stop_reason", None) == "max_tokens":
                logger.error(f"{self.name}: respuesta cortada por el limite de tokens (MAX_TOKENS={MAX_TOKENS})")
                return {
                    "status": "error",
                    "resultado": "Respuesta cortada por limite de tokens",
                    "detalles": {"raw_response": result_text, "stop_reason": "max_tokens", "max_tokens": MAX_TOKENS},
                    "siguiente_paso": "escalación",
                    "notas_audit": f"Agente {self.name}: la respuesta se corto al llegar a MAX_TOKENS={MAX_TOKENS}. Subir el limite."
                }

            # Parsear JSON de la respuesta
            try:
                result = json.loads(_limpiar_json(result_text))
            except json.JSONDecodeError:
                logger.warning(f"{self.name} no retornó JSON válido")
                result = {
                    "status": "error",
                    "resultado": "Respuesta no JSON",
                    "detalles": {"raw_response": result_text},
                    "siguiente_paso": "escalación",
                    "notas_audit": f"Agente {self.name} no retornó formato JSON"
                }

            return result

        except Exception as e:
            logger.error(f"Error en {self.name}: {str(e)}")
            return {
                "status": "error",
                "resultado": f"Error de ejecución: {str(e)}",
                "detalles": {},
                "siguiente_paso": "escalación",
                "notas_audit": f"Excepción en {self.name}: {str(e)}"
            }


class ContableCrew:
    """Crew de contadores especializados para Pulpo"""

    def __init__(self):
        # Definir agentes especializados
        self.clasificador = ContableAgent(
            name="Clasificador Contable",
            role="analista de documentos",
            expertise="""Clasificar documentos contables, extraer datos estructurados,
            identificar tipo de transacción (factura, nota crédito, cheque, etc),
            detectar anomalías obvias."""
        )

        self.validador = ContableAgent(
            name="Validador Normativo",
            role="auditor de cumplimiento",
            expertise="""Validar documentos contra normativas DIAN y NIIF,
            revisar datos requeridos y coherencia documental,
            alertar sobre incumplimientos o riesgos legales."""
        )

        self.registrador = ContableAgent(
            name="Registrador de Asientos",
            role="contador general",
            expertise="""Generar asientos contables según PUC usando los valores de
            'calculos_oficiales', documentar origen y destino de fondos,
            proponer cuentas de contra-partida."""
        )

        self.reportero = ContableAgent(
            name="Reportero de Consolidación",
            role="analista de reportes",
            expertise="""Consolidar transacciones en reportes, validar balances,
            generar notas explicativas, proponer ajustes finales."""
        )

        self.audit_trail = []

    def process_document(self, document_data: dict, hoy: Optional[date] = None) -> dict:
        """Procesa un documento a través del crew completo"""

        hoy = hoy or date.today()
        logger.info(f"Iniciando procesamiento de documento: {document_data.get('id', 'sin_id')}")

        # PASO 0: PREVALIDACIÓN DETERMINISTA (sin modelo, sin costo)
        pre = prevalidar(document_data, hoy)
        if pre["rechazos"]:
            logger.warning(f"Documento rechazado en prevalidación: {pre['rechazos']}")
            return {
                "status": "rechazado",
                "documento_id": document_data.get("id"),
                "razon": "; ".join(pre["rechazos"]),
                "detalles": {"motivos": pre["rechazos"], "origen": "prevalidacion_determinista"},
                "audit_trail": self.audit_trail
            }

        # PASO 1: CLASIFICACIÓN
        logger.info("→ PASO 1: Clasificación")
        clasificacion = self.clasificador.execute(
            task_description="""Analiza este documento contable:
            1. Identifica tipo (factura, recibo, cheque, nota crédito, etc)
            2. Extrae datos principales (número, fecha, valores, partes)
            3. Detecta anomalías visuales obvias
            4. Sugiere categoría contable preliminar
            5. En 'detalles' incluye siempre 'tipo_documento' (uno de: factura_compra, nota_credito, otro) y 'concepto' (uno de: bienes, servicios, otro)""",
            document_data=document_data
        )
        self.audit_trail.append({
            "paso": 1,
            "agente": "Clasificador",
            "resultado": clasificacion
        })

        if clasificacion["status"] == "error":
            logger.error("Clasificación falló, abortando")
            return {
                "status": "error",
                "documento_id": document_data.get("id"),
                "error": "Fallo en clasificación inicial",
                "audit_trail": self.audit_trail
            }

        # CÁLCULOS OFICIALES (código determinista)
        det_clas = clasificacion.get("detalles", {})
        if not isinstance(det_clas, dict):
            det_clas = {}
        tipo = normalizar_tipo(document_data.get("tipo")) or normalizar_tipo(det_clas.get("tipo_documento"))
        concepto = document_data.get("concepto") or det_clas.get("concepto")
        concepto = str(concepto).strip().lower() if concepto else None
        calculos = calcular(document_data, tipo, concepto, hoy)
        logger.info(f"Cálculos oficiales: determinable={calculos['determinable']}")

        # PASO 2: VALIDACIÓN
        logger.info("→ PASO 2: Validación Normativa")
        # La clasificación va en su propia clave para no pisar los datos originales
        document_enriched = {**document_data, "clasificacion": det_clas, "calculos_oficiales": calculos}

        validacion = self.validador.execute(
            task_description=f"""Valida este documento clasificado como {clasificacion['resultado']}:
            1. Revisa contra normativas DIAN y NIIF
            2. Verifica coherencia documental (datos del documento, partes, fecha)
            3. Confirma datos requeridos completos
            4. Alerta sobre riesgos de cumplimiento
            Los cálculos de IVA, retenciones y neto están en 'calculos_oficiales' y ya fueron verificados por el sistema: no los recalcules ni los discutas.""",
            document_data=document_enriched
        )
        self.audit_trail.append({
            "paso": 2,
            "agente": "Validador",
            "resultado": validacion
        })

        if validacion["status"] == "error":
            logger.warning(f"Documento rechazado: {validacion['resultado']}")
            return {
                "status": "rechazado",
                "documento_id": document_data.get("id"),
                "razon": validacion["resultado"],
                "detalles": validacion.get("detalles", {}),
                "audit_trail": self.audit_trail
            }

        # PASO 3: GENERACIÓN DE ASIENTOS
        logger.info("→ PASO 3: Registro de Asientos")
        asientos = self.registrador.execute(
            task_description="""Genera el asiento contable de este documento validado, usando EXACTAMENTE los valores de 'calculos_oficiales'.
            1. Elige las cuentas del PUC (código y nombre) para cada línea
            2. Débito: la compra o activo por 'base_gravable' y el IVA descontable por 'iva' (si es mayor que 0)
            3. Crédito: 'retefuente.valor' y 'reteiva.valor' (solo si 'aplica' es true) y 'neto_a_pagar' a proveedores
            4. Si el documento es nota crédito, invierte débitos y créditos
            5. Entrega 'detalles.asiento' como lista de líneas {"cuenta": "código — nombre", "debito": número, "credito": número}, con números sin separadores de miles y 0 donde no aplique
            6. Si 'calculos_oficiales.determinable' es false, no inventes valores: responde status 'pendiente' y explica qué falta""",
            document_data=document_enriched
        )
        self.audit_trail.append({
            "paso": 3,
            "agente": "Registrador",
            "resultado": asientos
        })

        if asientos["status"] == "error":
            logger.error(f"No se pudieron generar asientos: {asientos['resultado']}")
            return {
                "status": "error",
                "documento_id": document_data.get("id"),
                "error": "Fallo en generación de asientos",
                "audit_trail": self.audit_trail
            }

        # PASO 4: CONSOLIDACIÓN Y REPORTE
        logger.info("→ PASO 4: Consolidación y Reporte")
        transacciones_consolidadas = {
            **document_enriched,
            "asientos": asientos.get("detalles", {}),
            "validaciones": validacion.get("detalles", {})
        }

        reporte = self.reportero.execute(
            task_description="""Consolida y genera reporte final:
            1. Valida que asientos balancea (débitos = créditos)
            2. Resume transacción en lenguaje ejecutivo
            3. Genera notas explicativas
            4. Propone status final (registrado, pendiente, rechazado)""",
            document_data=transacciones_consolidadas
        )
        self.audit_trail.append({
            "paso": 4,
            "agente": "Reportero",
            "resultado": reporte
        })

        # VERIFICACIÓN FINAL Y ESTADO (lo decide el código, no los modelos)
        motivos = list(pre["revisiones"])
        if not calculos["determinable"]:
            motivos.extend(calculos["advertencias"])
        for nombre, res in (("Validador", validacion), ("Registrador", asientos), ("Reportero", reporte)):
            if not _paso_ok(res):
                motivos.append(f"{nombre} dejó su paso en '{res.get('status')}': {res.get('resultado')}")

        verificacion = {"ejecutada": False, "ok": None, "discrepancias": []}
        if calculos["determinable"]:
            discrepancias = verificar_asiento(calculos, asientos.get("detalles", {}))
            verificacion = {"ejecutada": True, "ok": not discrepancias, "discrepancias": discrepancias}
            motivos.extend(f"Asiento: {d}" for d in discrepancias)

        estado = "procesado" if not motivos else "requiere_revision"

        # RESULTADO FINAL
        resultado_final = {
            "status": estado,
            "documento_id": document_data.get("id"),
            "tipo": tipo or "desconocido",
            "descripcion_tipo": clasificacion.get("resultado", ""),
            "motivos_revision": motivos,
            "calculos_oficiales": calculos,
            "verificacion": verificacion,
            "clasificacion": clasificacion,
            "validacion": validacion,
            "asientos": asientos,
            "reporte": reporte,
            "timestamp": datetime.now().isoformat(),
            "audit_trail": self.audit_trail
        }

        if estado == "procesado":
            logger.info("✓ Documento procesado exitosamente")
        else:
            logger.warning(f"Documento requiere revisión: {motivos}")
        return resultado_final


def main():
    """Función principal - lee desde stdin, procesa, escribe a stdout"""

    try:
        # Leer documento desde stdin
        input_data = sys.stdin.read()

        if not input_data.strip():
            logger.error("No se recibió entrada")
            print(json.dumps({
                "status": "error",
                "error": "Entrada vacía"
            }))
            sys.exit(1)

        # Parsear JSON
        try:
            document_data = json.loads(input_data)
        except json.JSONDecodeError as e:
            logger.error(f"JSON inválido: {str(e)}")
            print(json.dumps({
                "status": "error",
                "error": f"JSON parsing error: {str(e)}"
            }))
            sys.exit(1)

        # Crear crew y procesar
        crew = ContableCrew()
        resultado = crew.process_document(document_data)

        # Escribir resultado a stdout (debe ser JSON válido)
        print(json.dumps(resultado, indent=2, ensure_ascii=False))

        # Exit code basado en resultado
        sys.exit(0 if resultado["status"] in ["procesado", "rechazado", "requiere_revision"] else 1)

    except Exception as e:
        logger.exception(f"Error fatal: {str(e)}")
        print(json.dumps({
            "status": "error",
            "error": f"Fatal error: {str(e)}"
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
