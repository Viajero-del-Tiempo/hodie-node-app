import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { loadImageFromUrl } from "../services/image.service.js";
import { toDate } from "../utils/date.util.js";

export const generateOrderPDF = async (order) => {
  return new Promise(async (resolve, reject) => {
    try {
      const fileName = `pedido-${order.orderNumber}.pdf`;
      const filePath = path.join(process.cwd(), "temp", fileName);

      if (!fs.existsSync("temp")) fs.mkdirSync("temp", { recursive: true });

      const fontRegular = path.join(
        process.cwd(),
        "assets",
        "fonts",
        "Poppins-Regular.ttf"
      );
      const fontBold = path.join(
        process.cwd(),
        "assets",
        "fonts",
        "Poppins-Bold.ttf"
      );

      const golden = "#f59e0b";

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 70, bottom: 70, left: 60, right: 60 },
      });

      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      doc.registerFont("Poppins", fontRegular);
      doc.registerFont("Poppins-Bold", fontBold);

      // ======================================================
      // FUNCIÓN DEL BORDE (REUSABLE)
      // ======================================================
      const drawBorder = () => {
        doc
          .save()
          .lineWidth(3)
          .strokeColor(golden)
          .roundedRect(40, 40, doc.page.width - 80, doc.page.height - 80, 12)
          .stroke()
          .restore();
      };

      // Dibujar borde en la primera página
      drawBorder();

      // Dibujar borde en cada página nueva
      doc.on("pageAdded", () => {
        drawBorder();
      });

      // ======================================================
      // LOGO
      // ======================================================
      const logoPath = path.join(process.cwd(), "assets", "logo.png");
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 75, 50, { width: 140 });
      }

      const divider = () => {
        doc
          .moveTo(60, doc.y)
          .lineTo(doc.page.width - 60, doc.y)
          .strokeColor(golden)
          .lineWidth(1.2)
          .stroke();
        doc.moveDown(1.2);
      };

      // Título
      doc
        .font("Poppins-Bold")
        .fontSize(28)
        .fillColor(golden)
        .text("Pedido", { align: "right" });

      doc
        .font("Poppins")
        .fontSize(16)
        .fillColor("#333333")
        .text(`#${order.orderNumber}`, { align: "right" });

      doc.moveDown(4);
      divider();

      // ======================================================
      // INFORMACIÓN CLIENTE
      // ======================================================
      doc
        .font("Poppins-Bold")
        .fontSize(22)
        .fillColor(golden)
        .text("Información del Cliente");

      doc.moveDown(0.7);

      doc
        .font("Poppins")
        .fontSize(16)
        .fillColor("#333")
        .text(`Nombre: ${order.userDisplayName}`)
        .text(`Teléfono: ${order.userPhoneNumber}`)
        .text(
          `Fecha del pedido: ${(toDate(order.createdAt) || new Date()).toLocaleString("es-PY", {
            timeZone: "America/Asuncion", // GMT-3
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}`
        );

      doc.moveDown(1.5);
      divider();

      // ======================================================
      // ÍTEMS
      // ======================================================
      doc
        .font("Poppins-Bold")
        .fontSize(22)
        .fillColor(golden)
        .text("Ítems del Pedido");

      doc.moveDown(1);

      for (const item of order.items) {
        // Definir precio total y descripción según el packaging
        const priceTotal = item.selectedPackaging
          ? item.price + item.selectedPackaging.price
          : item.price;

        const productDescription = item.selectedPackaging
          ? ` con ${item.selectedPackaging.name}`
          : "";

        // Cargar la imagen correspondiente
        let productImage = null;
        try {
          const imageUrl = item.selectedPackaging?.imageUrl || item.imageUrl;
          if (imageUrl && (imageUrl.startsWith("http://") || imageUrl.startsWith("https://"))) {
            productImage = await loadImageFromUrl(imageUrl);
          }
        } catch (err) {
          console.log(
            `Falló al cargar la imagen de ${
              item.selectedPackaging ? "packaging" : "producto"
            }`,
            err
          );
        }

        // Revisar espacio en página y agregar nueva si es necesario
        const spaceLeftItem = doc.page.height - doc.y - 100; // margen de seguridad
        if (spaceLeftItem < 50) doc.addPage();

        // Mostrar imagen si existe
        if (productImage) {
          try {
            doc.image(productImage, { width: 85 });
          } catch (err) {
            console.log(
              `Falló al incrustar la imagen de ${
                item.selectedPackaging ? "packaging" : "producto"
              } en el PDF:`,
              err.message
            );
          }
        }

        // Definir estilo de texto una sola vez
        doc.font("Poppins").fontSize(15).fillColor("#333");

        // Información del producto
        doc
          .text(`Producto: ${item.productName}${productDescription}`)
          .text(`Código: ${item.productSku}`)
          .text(`Cantidad: ${item.quantity}`)
          .text(
            `Precio unitario del producto: ${item.price.toLocaleString()} Gs.`
          )
          .moveDown(1);

        // Información del packaging si existe
        if (item.selectedPackaging) {
          doc
            .text(
              `Precio unitario del paquete: ${item.selectedPackaging.price.toLocaleString()} Gs.`
            )
            .moveDown(1);
        }

        // Subtotal
        doc
          .text(
            `Subtotal: ${(priceTotal * item.quantity).toLocaleString()} Gs.`
          )
          .moveDown(1);

        // Divider entre productos
        divider();
      }

      // ======================================================
      // DIRECCIÓN
      // ======================================================
      doc
        .font("Poppins-Bold")
        .fontSize(22)
        .fillColor(golden)
        .text("Dirección de Envío");

      doc.moveDown(0.8);

      doc
        .font("Poppins")
        .fontSize(16)
        .fillColor("#333")
        .text(`Ciudad: ${order.shippingAddress.city}`)
        .text(`Departamento: ${order.shippingAddress.department}`)
        .text(`Dirección: ${order.shippingAddress.street}`);

      if (order.shippingAddress.instructions) {
        doc.text(`Instrucciones: ${order.shippingAddress.instructions}`);
      }

      doc.moveDown(1.5);
      divider();

      // ======================================================
      // TOTALES
      // ======================================================
      doc.font("Poppins-Bold").fontSize(22).fillColor(golden).text("Totales");

      doc.moveDown(0.7);

      const isLocalGratis = order.shippingMethod === "local_gratis";
      const shippingTypeLabel = isLocalGratis
        ? "Envío local gratuito (Minga Guazú)"
        : "Envío por transportadora (pago contra entrega)";
      const shippingCostLabel = isLocalGratis
        ? "Gratis (0 Gs.)"
        : "Pago contra entrega (a abonar a transportadora)";

      doc
        .font("Poppins")
        .fontSize(16)
        .fillColor("#333")
        .text(`Subtotal: ${order.subtotal.toLocaleString()} Gs.`)
        .text(`Tipo de envío: ${shippingTypeLabel}`)
        .text(`Costo de envío: ${shippingCostLabel}`)
        .moveDown(0.5);

      doc
        .font("Poppins-Bold")
        .fontSize(28)
        .fillColor(golden)
        .text(`Total a pagar: ${order.total.toLocaleString()} Gs.`, {
          align: "right",
        });

      doc.moveDown(2);
      divider();

      // ======================================================
      // IMAGEN BANCARIA (CON PREVENCIÓN DE OVERFLOW)
      // ======================================================
      const bankImagePath = path.join(process.cwd(), "assets", "banco.png");

      if (fs.existsSync(bankImagePath)) {
        const spaceLeft = doc.page.height - doc.y - 100; // margen de seguridad

        // nueva página
        doc.addPage();

        doc
          .font("Poppins-Bold")
          .fontSize(22)
          .fillColor(golden)
          .text("Información de Pago");

        doc.image(bankImagePath, {
          //fit: [doc.page.width - 60, 360], // ajuste perfecto sin desbordar
          //align: "center",
        });

        doc.moveDown(1.5);
      }

      // ======================================================
      // PIE
      // ======================================================
      // nueva página
      doc.addPage();
      // Obtener tamaño de página
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;

      // Texto
      const text = "Gracias por su compra";

      // Obtener ancho y alto del texto
      const textWidth = doc.widthOfString(text);
      const textHeight = doc.heightOfString(text, { width: pageWidth });

      // Calcular posición centrada
      const x = (pageWidth - textWidth) / 2;
      const y = (pageHeight - textHeight) / 2;

      doc.font("Poppins").fontSize(28).fillColor("#666").text(text, x, y, {
        align: "center",
        width: textWidth,
      });

      doc.end();

      stream.on("finish", () => resolve(filePath));
      stream.on("error", reject);
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });
};
