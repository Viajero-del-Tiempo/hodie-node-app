import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { loadImageFromUrl } from "../services/image.service.js";

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
          `Fecha del pedido: ${new Date(
            order.createdAt.seconds * 1000
          ).toLocaleString()}`
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
        let productImage = null;
        if (item.selectedPackaging === null) {
          try {
            productImage = await loadImageFromUrl(item.imageUrl);
          } catch (_) {}
        } else {
          try {
            productImage = await loadImageFromUrl(
              item.selectedPackaging.imageUrl
            );
          } catch (_) {}
        }

        // Si no hay espacio → nueva página
        const spaceLeftItem = doc.page.height - doc.y - 100; // margen de seguridad
        if (spaceLeftItem < 50) doc.addPage();

        if (productImage) doc.image(productImage, { width: 85 });

        doc
          .font("Poppins")
          .fontSize(15)
          .fillColor("#333")
          .text(
            `Producto: ${item.productName} con ${item.selectedPackaging.name}`
          )
          .text(`Código: ${item.productSku}`)
          .text(`Cantidad: ${item.quantity}`)
          .text(`Precio unitario: ${item.price.toLocaleString()} Gs.`)
          .text(
            `Subtotal: ${(item.price * item.quantity).toLocaleString()} Gs.`
          )
          .moveDown(1);

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

      doc
        .font("Poppins")
        .fontSize(16)
        .fillColor("#333")
        .text(`Subtotal: ${order.subtotal.toLocaleString()} Gs.`)
        .text(`Costo de envío: ${order.shippingCost.toLocaleString()} Gs.`)
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

        // Si no hay espacio → nueva página
        if (spaceLeft < 280) doc.addPage();

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
      doc
        .font("Poppins")
        .fontSize(28)
        .fillColor("#666")
        .text("Gracias por su compra", { align: "center" });

      doc.end();

      stream.on("finish", () => resolve(filePath));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
};
