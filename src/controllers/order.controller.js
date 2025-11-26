import { generateOrderPDF } from '../services/pdf.service.js';
import { sendOrderPDF, sendOrderStatus } from '../services/whatsapp.service.js';
import fs from 'fs';

export const sendOrder = async (req, res) => {
  try {
    const order = req.body;

    // ============================
    // VALIDACIONES BÁSICAS
    // ============================
    if (!order || typeof order !== 'object') {
      return res.status(400).json({ error: 'Datos del pedido inválidos.' });
    }

    const requiredFields = [
      'id',
      'orderNumber',
      'userId',
      'userDisplayName',
      'userPhoneNumber',
      'items',
      'shippingAddress',
      'subtotal',
      'total',
      'createdAt'
    ];

    for (const field of requiredFields) {
      if (!order[field]) {
        return res.status(400).json({
          error: `Falta el campo obligatorio: ${field}`
        });
      }
    }

    if (!Array.isArray(order.items) || order.items.length === 0) {
      return res.status(400).json({
        error: 'El pedido debe contener al menos un ítem.'
      });
    }

    // ============================
    // GENERAR PDF PREMIUM
    // ============================
    const pdfPath = await generateOrderPDF(order);

    // ============================
    // ENVIAR PDF POR WHATSAPP
    // ============================
    const sent = await sendOrderPDF(order.userPhoneNumber, pdfPath);

    if (!sent) {
      return res.status(500).json({
        error: 'El PDF se generó, pero no se pudo enviar por WhatsApp.'
      });
    }

    // ============================
    // RESPUESTA AL FRONT
    // ============================
    res.json({
      success: true,
      message: `Pedido ${order.orderNumber} procesado y enviado al cliente.`,
      file: pdfPath
    });

    // ============================
    // LIMPIAR ARCHIVO TEMPORAL
    // ============================
    setTimeout(() => {
      try {
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
      } catch (err) {
        console.error('Error eliminando archivo temporal:', err);
      }
    }, 30000);

  } catch (error) {
    console.error('Error en sendOrder:', error);
    res.status(500).json({ error: 'Error procesando el pedido.' });
  }
};

export const updateOrderStatus = async (req, res) => {
try {
    const { phone, status, amount } = req.body;

    if (!phone || !status) {
      return res.status(400).json({
        error: "Los campos 'phone' y 'status' son requeridos"
      });
    }

    // Envia el mensaje por WhatsApp
    await sendOrderStatus(phone, status, amount);

    return res.json({
      success: true,
      message: "Estado enviado correctamente por WhatsApp"
    });

  } catch (err) {
    console.error("Error en updateOrderStatus:", err);
    return res.status(500).json({
      error: "Error enviando el estado del pedido"
    });
  }
};
