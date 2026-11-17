# Pruebas automáticas

`probar_app.py` revisa la app de punta a punta (41 pruebas): crear cada tipo de documento,
doble clic, valores en $0 o negativos, numeración, inventario, clientes, copias de seguridad,
celular y modo sin internet.

Para correrlas:

```bash
pip install playwright
playwright install chromium
python -m http.server 8090          # en la carpeta de la app, en otra ventana
python pruebas/probar_app.py http://127.0.0.1:8090/
```

La prueba de "Restaurar datos-version2.json" necesita ese archivo; cambia la ruta en el script
por donde lo tengas, o borra esa prueba.

Cada vez que cambies algo de la app, córrelas: si todo dice PASA, no rompiste nada.
