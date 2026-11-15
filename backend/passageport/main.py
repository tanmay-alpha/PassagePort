"""ASGI entrypoint: ``uvicorn passageport.main:app``."""

from passageport.app import create_app

app = create_app()
