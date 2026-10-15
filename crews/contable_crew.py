#!/usr/bin/env python3
"""
Crew Contable — Orquestación de agentes para procesamiento de documentos contables colombianos
Sistema: Pulpo Orchestrator
Autor: Diego Vélez
Fecha: Oct 2026
"""

import os
import sys
import json
import logging
from typing import Optional
from datetime import datetime
from anthropic import Anthropic

# Configurar logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger(__name__)

# Inicializar cliente Anthropic
client = Anthropic()
MODEL = "claude-opus-4-6"
MAX_TOKENS = 2000


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
- Retención en la fuente: 4% (personas jurídicas), 8% (personas naturales)
- Retención IVA: 15% (servicios), 75% (importaciones)

Instrucciones:
1. Responde SIEMPRE en JSON válido
2. Sé preciso y referencia normativas cuando aplique
3. Cuando no puedas resolver, sugiere escalación
4. Valida datos según estándares colombianos
5. Mantén trazabilidad de decisiones

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
            
            # Parsear JSON de la respuesta
            try:
                result = json.loads(result_text)
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
            verificar integridad matemática, revisar datos requeridos,
            alertar sobre incumplimientos o riesgos legales."""
        )
        
        self.registrador = ContableAgent(
            name="Registrador de Asientos",
            role="contador general",
            expertise="""Generar asientos contables según PUC, calcular impuestos
            (IVA, retención), documentar origen y destino de fondos,
            proponer cuentas de contra-partida."""
        )
        
        self.reportero = ContableAgent(
            name="Reportero de Consolidación",
            role="analista de reportes",
            expertise="""Consolidar transacciones en reportes, validar balances,
            generar notas explicativas, proponer ajustes finales."""
        )
        
        self.audit_trail = []
    
    def process_document(self, document_data: dict) -> dict:
        """Procesa un documento a través del crew completo"""
        
        logger.info(f"Iniciando procesamiento de documento: {document_data.get('id', 'sin_id')}")
        
        # PASO 1: CLASIFICACIÓN
        logger.info("→ PASO 1: Clasificación")
        clasificacion = self.clasificador.execute(
            task_description="""Analiza este documento contable:
            1. Identifica tipo (factura, recibo, cheque, nota crédito, etc)
            2. Extrae datos principales (número, fecha, valores, partes)
            3. Detecta anomalías visuales obvias
            4. Sugiere categoría contable preliminar""",
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
        
        # PASO 2: VALIDACIÓN
        logger.info("→ PASO 2: Validación Normativa")
        document_enriched = {**document_data, **clasificacion.get("detalles", {})}
        
        validacion = self.validador.execute(
            task_description=f"""Valida este documento clasificado como {clasificacion['resultado']}:
            1. Revisa contra normativas DIAN y NIIF
            2. Verifica integridad matemática (sumas, cálculos)
            3. Confirma datos requeridos completos
            4. Alerta sobre riesgos de cumplimiento""",
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
            task_description=f"""Genera asientos contables para este documento validado:
            1. Identifica cuentas débito/crédito según PUC
            2. Calcula IVA (5%, 19%, exento según tipo)
            3. Calcula retención en fuente si aplica
            4. Documenta origen y destino de recursos
            5. Propone contra-partida balanceada""",
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
        
        # RESULTADO FINAL
        resultado_final = {
            "status": "procesado",
            "documento_id": document_data.get("id"),
            "tipo": clasificacion.get("resultado", "desconocido"),
            "clasificacion": clasificacion,
            "validacion": validacion,
            "asientos": asientos,
            "reporte": reporte,
            "timestamp": datetime.now().isoformat(),
            "audit_trail": self.audit_trail
        }
        
        logger.info(f"✓ Documento procesado exitosamente")
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
        sys.exit(0 if resultado["status"] in ["procesado", "rechazado"] else 1)
    
    except Exception as e:
        logger.exception(f"Error fatal: {str(e)}")
        print(json.dumps({
            "status": "error",
            "error": f"Fatal error: {str(e)}"
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
