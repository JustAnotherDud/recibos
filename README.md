# Recibos

Dashboard pessoal de recibos de vencimento: bruto, líquido, subsídios, descontos e taxas por hora, mês a mês.

## Dados

O repo não guarda dados. A página lê a view `mensal_consolidado` do projeto Supabase "Income" com supabase-js e a publishable key. O RLS só deixa ler ao utilizador autenticado, por isso sem login a página não mostra nada.

## Correr

É HTML, CSS e JS sem build. Serve a pasta com qualquer servidor estático:

```bash
python -m http.server 8000
```

Abre `http://localhost:8000` e entra com email e password da conta Supabase.

Em produção corre no GitHub Pages, a partir do branch `main`.

## Licença

MIT
