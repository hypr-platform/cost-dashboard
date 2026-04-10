"""
Rode este script UMA VEZ para gerar o refresh token do Google.
Depois disso o dashboard usa o token automaticamente.

Uso:
    .venv/bin/python generate_token.py
"""

import json
import os
from google_auth_oauthlib.flow import InstalledAppFlow
from dotenv import load_dotenv

load_dotenv()

SCOPES = [
    "https://www.googleapis.com/auth/display-video",
    "https://www.googleapis.com/auth/doubleclickbidmanager",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
]

OAUTH_FILE = "oauth-credentials.json"
TOKEN_FILE = "dv360-token.json"


def main():
    if not os.path.exists(OAUTH_FILE):
        print(f"Arquivo '{OAUTH_FILE}' não encontrado.")
        print("Baixe o OAuth JSON do Google Cloud Console e coloque na pasta do projeto.")
        return

    flow = InstalledAppFlow.from_client_secrets_file(OAUTH_FILE, scopes=SCOPES)
    creds = flow.run_local_server(port=0, open_browser=True)

    token_data = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes),
    }

    with open(TOKEN_FILE, "w") as f:
        json.dump(token_data, f, indent=2)

    print(f"\nToken salvo em '{TOKEN_FILE}'")
    print("Agora configure o .env:")
    print(f"  DV360_TOKEN_JSON={TOKEN_FILE}")
    print(f"  DV360_OAUTH_JSON={OAUTH_FILE}")


if __name__ == "__main__":
    main()
