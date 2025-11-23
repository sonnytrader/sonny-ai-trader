async function login(event) {
  event.preventDefault();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value.trim();

  if (!email || !password) {
    alert("Lütfen e-posta ve şifre girin.");
    return;
  }

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    if (response.ok) {
      alert("Giriş başarılı");

      // Giriş modalını kapat
      const loginModal = document.getElementById("loginModal");
      if (loginModal) loginModal.style.display = "none";

      // Arka plan paket ekranını gizle
      const packageScreen = document.getElementById("packageSelection");
      if (packageScreen) packageScreen.style.display = "none";

      // Sayfayı yönlendir
      window.location.href = "/dashboard.html";
    } else {
      alert("Giriş başarısız. Lütfen bilgileri kontrol edin.");
    }
  } catch (error) {
    console.error("Giriş hatası:", error);
    alert("Sunucu hatası oluştu.");
  }
}
