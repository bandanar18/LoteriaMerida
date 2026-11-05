/** Niveles KYC (Doc. Maestro §6.2): qué documentos exige cada subida de nivel. */

export type KycDocumentType = 'ID_FRONT' | 'ID_BACK' | 'SELFIE' | 'PROOF_OF_ADDRESS' | 'SOURCE_OF_FUNDS';

export const KYC_DOCUMENT_LABELS: Record<KycDocumentType, string> = {
  ID_FRONT: 'Cédula o pasaporte (frente)',
  ID_BACK: 'Cédula (reverso)',
  SELFIE: 'Selfie sosteniendo el documento',
  PROOF_OF_ADDRESS: 'Comprobante de domicilio',
  SOURCE_OF_FUNDS: 'Comprobante de origen de fondos',
};

export const KYC_REQUIREMENTS: Record<2 | 3, { required: KycDocumentType[]; optional: KycDocumentType[] }> = {
  2: { required: ['ID_FRONT', 'SELFIE'], optional: ['ID_BACK'] },
  3: { required: ['PROOF_OF_ADDRESS', 'SOURCE_OF_FUNDS'], optional: [] },
};

export const KYC_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Valida una solicitud de subida de nivel. Devuelve un mensaje de error o null. */
export function validateKycRequest(currentLevel: number, targetLevel: number, types: KycDocumentType[]): string | null {
  if (targetLevel !== 2 && targetLevel !== 3) return 'Nivel solicitado inválido';
  if (targetLevel <= currentLevel) return `Ya tienes nivel ${currentLevel}`;
  if (targetLevel === 3 && currentLevel < 2) return 'Primero debes completar el nivel 2';
  const req = KYC_REQUIREMENTS[targetLevel];
  const allowed = new Set([...req.required, ...req.optional]);
  const extra = types.find((t) => !allowed.has(t));
  if (extra) return `Documento no corresponde al nivel ${targetLevel}: ${KYC_DOCUMENT_LABELS[extra]}`;
  const missing = req.required.find((t) => !types.includes(t));
  if (missing) return `Falta: ${KYC_DOCUMENT_LABELS[missing]}`;
  return null;
}

/** Detecta el tipo real del archivo por su firma (no se confía en la extensión ni en el content-type del cliente). */
export function sniffMime(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-') return 'application/pdf';
  return null;
}
