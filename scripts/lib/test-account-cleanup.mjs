export async function deleteTestAuthUser({
  admin,
  userId,
  label,
  maxAttempts = 3,
  retryDelayMs = 500,
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
    if (deleteError && deleteError.status !== 404) {
      lastError = deleteError;
    } else {
      const { data, error: verifyError } =
        await admin.auth.admin.getUserById(userId);
      if (!data?.user && (!verifyError || verifyError.status === 404)) {
        return;
      }
      lastError =
        verifyError || new Error(`${label} auth user still exists after deletion`);
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, retryDelayMs * attempt)
      );
    }
  }

  throw new Error(
    `${label} auth-user cleanup failed after ${maxAttempts} attempts: ${
      lastError?.message || 'unknown error'
    }`
  );
}
