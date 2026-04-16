#!/usr/bin/env bash

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-site-hypr}"
SERVICE_NAME="${SERVICE_NAME:-cost-dashboard-api}"
REGION="${REGION:-southamerica-east1}"
ENV_FILE="${ENV_FILE:-cloudrun.backend.env.yaml}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "Erro: defina PROJECT_ID antes de rodar."
  echo "Exemplo: PROJECT_ID=meu-projeto ./deploy-backend-cloudrun.sh"
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Erro: arquivo de env '${ENV_FILE}' nao encontrado."
  exit 1
fi

echo "Projeto: ${PROJECT_ID}"
echo "Servico: ${SERVICE_NAME}"
echo "Regiao: ${REGION}"
echo "Env file: ${ENV_FILE}"

gcloud config set project "${PROJECT_ID}"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --cpu 0.5 \
  --memory 512Mi \
  --concurrency 1 \
  --timeout 300 \
  --min-instances 1 \
  --max-instances 1 \
  --clear-base-image \
  --env-vars-file "${ENV_FILE}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --format='value(status.url)')"
echo "Deploy concluido. URL: ${SERVICE_URL}"
