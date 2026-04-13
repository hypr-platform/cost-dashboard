export default function UnauthorizedPage() {
  return (
    <main className="container authContainer">
      <section className="panel authPanel">
        <p className="eyebrow">Acesso negado</p>
        <h1>Conta sem permissão</h1>
        <p className="muted">
          Este dashboard aceita apenas usuários com e-mail <strong>@hypr.mobi</strong>.
        </p>
      </section>
    </main>
  );
}
