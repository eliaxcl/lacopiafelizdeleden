import { createHmac } from "node:crypto";

const FLOW_API_URL = "https://www.flow.cl/api";

const BOOK = {
  id: "el-arte-de-las-velas-maestro-v1",
  name: "El Arte de las Velas — Maestro Definitivo",
  amount: 9900,
  currency: "CLP",
  file: "El_Arte_de_las_Velas_Maestro_Definitivo_v1.0.pdf"
};

const DOWNLOAD_TTL = 60 * 60 * 24; // 24 horas

function signParams(params, secretKey) {
  const keys = Object.keys(params).sort();

  let toSign = "";

  for (const key of keys) {
    toSign += key + params[key];
  }

  return createHmac("sha256", secretKey)
    .update(toSign)
    .digest("hex");
}

async function flowRequest(path, params, env) {
  const signedParams = {
    apiKey: env.FLOW_API_KEY,
    ...params
  };

  signedParams.s = signParams(
    signedParams,
    env.FLOW_SECRET_KEY
  );

  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(signedParams)) {
    form.append(key, String(value));
  }

  const response = await fetch(
    `${FLOW_API_URL}${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Flow HTTP ${response.status}: ${text}`
    );
  }

  return JSON.parse(text);
}

function isValidEmail(email) {
  return (
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

async function getPurchaseByCommerceOrder(
  commerceOrder,
  env
) {
  return await env.PURCHASES.get(
    `order:${commerceOrder}`,
    { type: "json" }
  );
}

async function getFlowStatus(token, env) {
  return await flowRequest(
    "/payment/getStatus",
    { token },
    env
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
     * =====================================================
     * HEALTH CHECK
     * =====================================================
     */
    if (url.pathname === "/api/test") {
      return Response.json({
        ok: true,
        worker: "lacopiafelizdeleden",
        r2: !!env.R2_BUCKET,
        purchases: !!env.PURCHASES,
        flow:
          !!env.FLOW_API_KEY &&
          !!env.FLOW_SECRET_KEY
      });
    }

    /*
     * =====================================================
     * CREAR PAGO
     * =====================================================
     */
    if (
      url.pathname === "/api/create-payment" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        const email = body.email?.trim();

        if (!isValidEmail(email)) {
          return Response.json(
            {
              ok: false,
              error: "Debes indicar un email válido."
            },
            { status: 400 }
          );
        }

        const commerceOrder = crypto.randomUUID();

        const origin = url.origin;

        /*
         * Guardamos primero la orden en KV.
         * Esto permite aceptar únicamente órdenes
         * que hayan sido creadas por nuestro Worker.
         */
        const purchase = {
          commerceOrder,
          productId: BOOK.id,
          productName: BOOK.name,
          amount: BOOK.amount,
          currency: BOOK.currency,
          email,
          status: "pending",
          createdAt: new Date().toISOString()
        };

        await env.PURCHASES.put(
          `order:${commerceOrder}`,
          JSON.stringify(purchase),
          {
            expirationTtl: 60 * 60 * 48
          }
        );

        const params = {
          commerceOrder,
          subject: BOOK.name,
          currency: BOOK.currency,
          amount: BOOK.amount,
          email,
          urlConfirmation:
            `${origin}/api/flow-confirmation`,
          urlReturn:
            `${origin}/api/flow-return`,
          timeout: 1800
        };

        const data = await flowRequest(
          "/payment/create",
          params,
          env
        );

        /*
         * Guardamos los datos entregados por Flow.
         */
        purchase.flowOrder = data.flowOrder;
        purchase.flowToken = data.token;

        await env.PURCHASES.put(
          `order:${commerceOrder}`,
          JSON.stringify(purchase),
          {
            expirationTtl: 60 * 60 * 48
          }
        );

        return Response.json({
          ok: true,
          checkoutUrl:
            `${data.url}?token=${data.token}`,
          flowOrder: data.flowOrder,
          commerceOrder
        });

      } catch (error) {
        console.error(
          "Error creando pago:",
          error
        );

        return Response.json(
          {
            ok: false,
            error: "No fue posible crear el pago."
          },
          { status: 500 }
        );
      }
    }

    /*
     * =====================================================
     * CONFIRMACIÓN DE FLOW
     * =====================================================
     */
    if (
      url.pathname === "/api/flow-confirmation" &&
      request.method === "POST"
    ) {
      try {
        const form = await request.formData();

        const token = form.get("token");

        if (!token) {
          return new Response(
            "Token no recibido",
            { status: 400 }
          );
        }

        /*
         * Consultamos directamente a Flow.
         */
        const status = await getFlowStatus(
          token,
          env
        );

        console.log(
          "Flow status:",
          JSON.stringify(status)
        );

        const commerceOrder =
          status.commerceOrder;

        if (!commerceOrder) {
          return new Response(
            "Orden no encontrada",
            { status: 400 }
          );
        }

        /*
         * Recuperamos nuestra orden original.
         */
        const purchase =
          await getPurchaseByCommerceOrder(
            commerceOrder,
            env
          );

        if (!purchase) {
          console.error(
            "Orden no existe en KV:",
            commerceOrder
          );

          return new Response(
            "Orden no reconocida",
            { status: 400 }
          );
        }

        /*
         * Validaciones de seguridad.
         */
        if (
          Number(status.amount) !==
          Number(purchase.amount)
        ) {
          console.error(
            "Monto incorrecto:",
            status.amount
          );

          return new Response(
            "Monto inválido",
            { status: 400 }
          );
        }

        if (
          status.currency !==
          purchase.currency
        ) {
          return new Response(
            "Moneda inválida",
            { status: 400 }
          );
        }

        /*
         * Flow:
         * 1 = pendiente
         * 2 = pagado
         * 3 = rechazado
         * 4 = cancelado
         */
        if (Number(status.status) !== 2) {
          purchase.status =
            Number(status.status) === 3
              ? "rejected"
              : Number(status.status) === 4
                ? "cancelled"
                : "pending";

          await env.PURCHASES.put(
            `order:${commerceOrder}`,
            JSON.stringify(purchase),
            {
              expirationTtl: 60 * 60 * 48
            }
          );

          return new Response(
            "OK",
            { status: 200 }
          );
        }

        /*
         * Pago confirmado.
         */
        const downloadToken =
          crypto.randomUUID();

        purchase.status = "paid";
        purchase.paidAt =
          new Date().toISOString();
        purchase.downloadToken =
          downloadToken;

        await env.PURCHASES.put(
          `order:${commerceOrder}`,
          JSON.stringify(purchase),
          {
            expirationTtl: DOWNLOAD_TTL
          }
        );

        /*
         * Token independiente para descargar.
         */
        await env.PURCHASES.put(
          `download:${downloadToken}`,
          JSON.stringify({
            commerceOrder,
            productId: BOOK.id,
            email: purchase.email,
            createdAt:
              new Date().toISOString(),
            expiresAt:
              new Date(
                Date.now() +
                DOWNLOAD_TTL * 1000
              ).toISOString()
          }),
          {
            expirationTtl: DOWNLOAD_TTL
          }
        );

        console.log(
          "Compra aprobada:",
          commerceOrder
        );

        return new Response(
          "OK",
          { status: 200 }
        );

      } catch (error) {
        console.error(
          "Error confirmando Flow:",
          error
        );

        /*
         * Flow espera una respuesta rápida.
         */
        return new Response(
          "OK",
          { status: 200 }
        );
      }
    }

    /*
     * =====================================================
     * RETORNO DEL COMPRADOR
     * =====================================================
     */
    if (
      url.pathname === "/api/flow-return"
    ) {
      try {
        const token =
          url.searchParams.get("token");

        if (!token) {
          return Response.json(
            {
              ok: false,
              error: "Token no recibido."
            },
            { status: 400 }
          );
        }

        const status =
          await getFlowStatus(
            token,
            env
          );

        if (
          Number(status.status) !== 2
        ) {
          return Response.json({
            ok: false,
            paid: false,
            message:
              "El pago todavía no figura como aprobado."
          });
        }

        const commerceOrder =
          status.commerceOrder;

        const purchase =
          await getPurchaseByCommerceOrder(
            commerceOrder,
            env
          );

        if (
          !purchase ||
          purchase.status !== "paid" ||
          !purchase.downloadToken
        ) {
          return Response.json({
            ok: false,
            paid: false,
            message:
              "La compra está siendo procesada."
          });
        }

        return Response.json({
          ok: true,
          paid: true,
          message:
            "Pago confirmado correctamente.",
          downloadUrl:
            `${url.origin}/api/download?token=${purchase.downloadToken}`
        });

      } catch (error) {
        console.error(
          "Error en retorno Flow:",
          error
        );

        return Response.json(
          {
            ok: false,
            error:
              "No fue posible verificar el pago."
          },
          { status: 500 }
        );
      }
    }

    /*
     * =====================================================
     * DESCARGA SEGURA
     * =====================================================
     */
    if (
      url.pathname === "/api/download"
    ) {
      try {
        const token =
          url.searchParams.get("token");

        if (!token) {
          return new Response(
            "Enlace inválido",
            { status: 403 }
          );
        }

        const authorization =
          await env.PURCHASES.get(
            `download:${token}`,
            { type: "json" }
          );

        if (!authorization) {
          return new Response(
            "Enlace expirado o inválido",
            { status: 403 }
          );
        }

        const purchase =
          await env.PURCHASES.get(
            `order:${authorization.commerceOrder}`,
            { type: "json" }
          );

        if (
          !purchase ||
          purchase.status !== "paid"
        ) {
          return new Response(
            "Compra no autorizada",
            { status: 403 }
          );
        }

        const object =
          await env.R2_BUCKET.get(
            BOOK.file
          );

        if (!object) {
          return new Response(
            "Libro no encontrado",
            { status: 404 }
          );
        }

        const headers = new Headers();

        object.writeHttpMetadata(headers);

        headers.set(
          "Content-Type",
          "application/pdf"
        );

        headers.set(
          "Content-Disposition",
          `attachment; filename="${BOOK.file}"`
        );

        headers.set(
          "Cache-Control",
          "private, no-store"
        );

        return new Response(
          object.body,
          { headers }
        );

      } catch (error) {
        console.error(
          "Error descargando libro:",
          error
        );

        return new Response(
          "Error interno",
          { status: 500 }
        );
      }
    }

    /*
     * =====================================================
     * IMPORTANTE:
     * Ya NO existe una URL pública directa
     * al PDF.
     * =====================================================
     */

    return new Response(
      "Not Found",
      {
        status: 404,
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }

}
